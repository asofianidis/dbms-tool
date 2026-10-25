//! Sign-in methods mysql_async can't use, reported clearly. ed25519 and parsec come from
//! its `client_ed25519` and `client_parsec` features; others (gssapi, pam) fail with an
//! error, which `connect_error` rewords.

use mysql_async::DriverError;

/// A clearer connect error for sign-in methods the driver doesn't support; None keeps
/// the driver's message.
pub fn connect_error(e: &mysql_async::Error, user: &str) -> Option<String> {
    match e {
        mysql_async::Error::Driver(DriverError::UnknownAuthPlugin { name }) => {
            let plugin = match name.as_str() {
                "auth_gssapi_client" => "gssapi (Kerberos)",
                "dialog" => "pam",
                other => other,
            };
            Some(format!(
                "The account '{user}' signs in with the {plugin} authentication plugin (client \
                 plugin {name}), which this app doesn't support. Use an account with \
                 mysql_native_password or caching_sha2_password."
            ))
        }
        mysql_async::Error::Driver(DriverError::CleartextPluginDisabled) => Some(format!(
            "The account '{user}' needs its password sent in clear text (PAM or LDAP \
             authentication), which this app only does for cloud IAM sign-in. Use an account \
             with mysql_native_password or caching_sha2_password."
        )),
        // ER_ACCESS_DENIED_NO_PASSWORD_ERROR: socket authentication, among others
        mysql_async::Error::Server(s) if s.code == 1698 => Some(format!(
            "ERROR {} ({}): {}. If the account uses unix_socket or auth_socket authentication, it \
             can only sign in over the server's local socket as the matching OS user; this app \
             connects over TCP.",
            s.code,
            s.state,
            s.message.trim_end_matches('.')
        )),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewords_unsupported_plugin_errors() {
        let e = mysql_async::Error::Driver(DriverError::UnknownAuthPlugin {
            name: "auth_gssapi_client".into(),
        });
        let m = connect_error(&e, "app").unwrap();
        assert!(m.contains("gssapi (Kerberos)"), "{m}");
        let e = mysql_async::Error::Driver(DriverError::CleartextPluginDisabled);
        assert!(connect_error(&e, "app").unwrap().contains("clear text"));
        let e = mysql_async::Error::Driver(DriverError::PacketTooLarge);
        assert_eq!(connect_error(&e, "app"), None);
    }
}
