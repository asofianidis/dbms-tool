//! TLS settings shared by the drivers: the CA and client certificate files of
//! a connection, and the checks each SSL mode asks for.

use crate::config::ConnectionConfig;
use crate::error::{AppError, AppResult};

/// A PKCS#12 bundle (certificate and key in one file) rather than PEM
pub fn is_pkcs12(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".p12") || lower.ends_with(".pfx")
}

pub fn read_file(path: &str, what: &str) -> AppResult<Vec<u8>> {
    std::fs::read(path).map_err(|e| AppError::msg(format!("Couldn't read the {what} {path}: {e}")))
}

/// The client certificate and key paths, checked for a missing half
pub enum ClientCert<'a> {
    Pkcs12(&'a str),
    Pem { cert: &'a str, key: &'a str },
}

pub fn client_cert(cfg: &ConnectionConfig) -> AppResult<Option<ClientCert<'_>>> {
    match (cfg.client_cert(), cfg.client_key()) {
        (None, None) => Ok(None),
        (None, Some(_)) => Err(AppError::msg(
            "A client key was chosen without a client certificate; choose both or neither",
        )),
        (Some(cert), None) if is_pkcs12(cert) => Ok(Some(ClientCert::Pkcs12(cert))),
        (Some(_), None) => Err(AppError::msg(
            "Choose the private key file for the client certificate (or use a .p12/.pfx bundle)",
        )),
        (Some(cert), Some(key)) => Ok(Some(ClientCert::Pem { cert, key })),
    }
}

/// MongoDB's single PEM file holding the client certificate and its key
pub fn combined_pem_cert(cfg: &ConnectionConfig) -> AppResult<Option<&str>> {
    match (cfg.client_cert(), cfg.client_key()) {
        (None, None) => Ok(None),
        (Some(cert), _) if is_pkcs12(cert) => Err(AppError::Unsupported(
            "MongoDB client certificates must be a PEM file holding the certificate and its key, \
             not a .p12/.pfx bundle"
                .into(),
        )),
        (Some(cert), None) => Ok(Some(cert)),
        (Some(cert), Some(key)) if cert == key => Ok(Some(cert)),
        _ => Err(AppError::Unsupported(
            "MongoDB needs the client certificate and its private key in one PEM file \
             (concatenate them); choose that file as the client certificate and leave the key empty"
                .into(),
        )),
    }
}

/// The client identity for native-tls: a PEM certificate with a PKCS#8 key,
/// or a PKCS#12 bundle without a password.
pub fn native_identity(cfg: &ConnectionConfig) -> AppResult<Option<native_tls::Identity>> {
    let identity = match client_cert(cfg)? {
        None => return Ok(None),
        Some(ClientCert::Pkcs12(path)) => {
            native_tls::Identity::from_pkcs12(&read_file(path, "client certificate")?, "").map_err(
                |e| {
                    AppError::msg(format!(
                        "Couldn't load the client certificate bundle {path}: {e}. \
                         Only bundles without a password are supported"
                    ))
                },
            )?
        }
        Some(ClientCert::Pem { cert, key }) => native_tls::Identity::from_pkcs8(
            &read_file(cert, "client certificate")?,
            &read_file(key, "client key")?,
        )
        .map_err(|e| {
            AppError::msg(format!(
                "Couldn't load the client certificate and key: {e}. The key must be an \
                 unencrypted PKCS#8 PEM file (\"BEGIN PRIVATE KEY\"); convert one with \
                 `openssl pkcs8 -topk8 -nocrypt -in client.key -out client-pkcs8.key`"
            ))
        })?,
    };
    Ok(Some(identity))
}

/// Every certificate in a PEM bundle, or a single DER certificate
pub fn native_root_certs(path: &str) -> AppResult<Vec<native_tls::Certificate>> {
    let bytes = read_file(path, "CA certificate")?;
    let certs = if bytes.windows(10).any(|w| w == b"-----BEGIN") {
        native_tls::Certificate::stack_from_pem(&bytes)
    } else {
        native_tls::Certificate::from_der(&bytes).map(|c| vec![c])
    };
    match certs {
        Ok(certs) if !certs.is_empty() => Ok(certs),
        Ok(_) => Err(AppError::msg(format!("No certificates found in {path}"))),
        Err(e) => Err(AppError::msg(format!(
            "Couldn't read the CA certificate {path}: {e}"
        ))),
    }
}

/// A native-tls connector honouring the SSL mode, CA file and client certificate
pub fn native_connector(cfg: &ConnectionConfig) -> AppResult<native_tls::TlsConnector> {
    let mut builder = native_tls::TlsConnector::builder();
    builder
        .danger_accept_invalid_certs(!cfg.verify_certificate())
        .danger_accept_invalid_hostnames(!cfg.verify_hostname());
    // A CA file is the only trust anchor, as with libpq; otherwise verify-ca
    // (no hostname check) would accept any publicly trusted certificate
    if let Some(path) = cfg.root_cert() {
        for cert in native_root_certs(path)? {
            builder.add_root_certificate(cert);
        }
        builder.disable_built_in_roots(true);
    }
    if let Some(identity) = native_identity(cfg)? {
        builder.identity(identity);
    }
    builder
        .build()
        .map_err(|e| AppError::msg(format!("TLS setup failed: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SslMode;

    fn cfg(ssl: SslMode, trust: bool) -> ConnectionConfig {
        serde_json::from_value(serde_json::json!({
            "id": "x", "name": "x", "engine": "postgres",
            "ssl": ssl, "trustServerCertificate": trust
        }))
        .unwrap()
    }

    #[test]
    fn verification_per_mode() {
        let checks = |ssl, trust| {
            let c = cfg(ssl, trust);
            (c.verify_certificate(), c.verify_hostname())
        };
        assert_eq!(checks(SslMode::Disable, false), (false, false));
        assert_eq!(checks(SslMode::Prefer, false), (false, false));
        assert_eq!(checks(SslMode::Require, false), (true, true));
        assert_eq!(checks(SslMode::Require, true), (false, false));
        // The verify modes ignore "trust server certificate"
        assert_eq!(checks(SslMode::VerifyCa, true), (true, false));
        assert_eq!(checks(SslMode::VerifyFull, true), (true, true));
    }

    #[test]
    fn client_cert_needs_both_halves_unless_pkcs12() {
        let mut c = cfg(SslMode::VerifyFull, false);
        assert!(client_cert(&c).unwrap().is_none());
        c.ssl_client_cert = "client.crt".into();
        assert!(client_cert(&c).is_err());
        c.ssl_client_cert = "C:/certs/Client.PFX".into();
        assert!(matches!(client_cert(&c), Ok(Some(ClientCert::Pkcs12(_)))));
        c.ssl_client_cert = String::new();
        c.ssl_client_key = "client.key".into();
        assert!(client_cert(&c).is_err());
        c.ssl_client_cert = " client.crt ".into();
        assert!(matches!(
            client_cert(&c),
            Ok(Some(ClientCert::Pem {
                cert: "client.crt",
                key: "client.key"
            }))
        ));
    }

    #[test]
    fn mongo_wants_one_pem_file() {
        let mut c = cfg(SslMode::VerifyFull, false);
        assert_eq!(combined_pem_cert(&c).unwrap(), None);
        c.ssl_client_cert = "client.pem".into();
        assert_eq!(combined_pem_cert(&c).unwrap(), Some("client.pem"));
        c.ssl_client_key = "client.pem".into();
        assert_eq!(combined_pem_cert(&c).unwrap(), Some("client.pem"));
        c.ssl_client_key = "client.key".into();
        assert!(combined_pem_cert(&c).is_err());
        c.ssl_client_key = String::new();
        c.ssl_client_cert = "client.p12".into();
        assert!(combined_pem_cert(&c).is_err());
    }

    #[test]
    fn missing_ca_file_names_the_file() {
        let Err(err) = native_root_certs("does-not-exist.pem") else {
            panic!("a missing file should fail");
        };
        let err = err.to_string();
        assert!(err.contains("does-not-exist.pem"), "{err}");
    }
}
