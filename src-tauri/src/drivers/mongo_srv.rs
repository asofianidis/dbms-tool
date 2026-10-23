//! Resolves `mongodb+srv://` strings into plain `mongodb://` seed lists before
//! the driver sees them. The driver's resolver (hickory) sends each DNS query
//! from a port it picks itself, which Windows Firewall treats as the app
//! listening and answers with an admin "Allow access" prompt. Letting the OS
//! pick the port avoids that, and the driver has no setting for it.
//!
//! The cost is SRV polling: the driver won't notice mongos nodes added to a
//! sharded cluster until the next connect.

use hickory_resolver::TokioResolver;
use hickory_resolver::proto::rr::RData;

use crate::error::{AppError, AppResult};

const SCHEME: &str = "mongodb+srv://";

/// Returns `uri` unchanged unless it's a `mongodb+srv://` string. Strings the
/// driver would reject also pass through, so its error reaches the user.
pub async fn expand(uri: &str) -> AppResult<String> {
    let Some(srv) = Srv::parse(uri) else {
        return Ok(uri.to_string());
    };
    let mut builder = TokioResolver::builder_tokio().map_err(|e| dns_error(srv.host, e))?;
    builder.options_mut().os_port_selection = true;
    let resolver = builder.build().map_err(|e| dns_error(srv.host, e))?;

    let service = srv.option("srvServiceName").unwrap_or("mongodb");
    let lookup = resolver
        .srv_lookup(format!("_{service}._tcp.{}", srv.host))
        .await
        .map_err(|e| dns_error(srv.host, e))?;
    let hosts = lookup
        .answers()
        .iter()
        .filter_map(|record| match &record.data {
            RData::SRV(s) => Some((s.target.to_utf8().trim_end_matches('.').to_string(), s.port)),
            _ => None,
        })
        .collect();

    let txt = match resolver.txt_lookup(srv.host).await {
        Ok(lookup) => lookup
            .answers()
            .iter()
            .filter_map(|record| match &record.data {
                RData::TXT(t) => Some(
                    t.txt_data
                        .iter()
                        .map(|b| String::from_utf8_lossy(b).into_owned())
                        .collect::<String>(),
                ),
                _ => None,
            })
            .collect(),
        Err(e) if e.is_no_records_found() => Vec::new(),
        Err(e) => return Err(dns_error(srv.host, e)),
    };

    srv.rewrite(hosts, &txt)
}

fn dns_error(host: &str, e: impl std::fmt::Display) -> AppError {
    AppError::msg(format!("DNS lookup for {host} failed: {e}"))
}

#[derive(Debug, PartialEq)]
struct Srv<'a> {
    userinfo: Option<&'a str>,
    host: &'a str,
    /// `/database`, or empty
    path: &'a str,
    options: Vec<(&'a str, &'a str)>,
}

impl<'a> Srv<'a> {
    fn parse(uri: &'a str) -> Option<Self> {
        let scheme = uri.get(..SCHEME.len())?;
        if !scheme.eq_ignore_ascii_case(SCHEME) {
            return None;
        }
        let rest = &uri[SCHEME.len()..];
        let (rest, query) = rest.split_once('?').unwrap_or((rest, ""));
        let (userinfo, rest) = match rest.rsplit_once('@') {
            Some((u, r)) => (Some(u), r),
            None => (None, rest),
        };
        let (host, path) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
        // A port, several hosts or a bare name are errors the driver words better
        if host.is_empty() || host.contains([':', ',']) || !host.contains('.') {
            return None;
        }
        let options = query
            .split('&')
            .filter(|pair| !pair.is_empty())
            .map(|pair| pair.split_once('=').unwrap_or((pair, "")))
            .collect();
        Some(Self {
            userinfo,
            host,
            path,
            options,
        })
    }

    fn option(&self, key: &str) -> Option<&'a str> {
        self.options
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| *v)
    }

    /// The `mongodb://` string for the looked-up hosts and TXT record, with the
    /// checks the SRV spec asks of drivers.
    fn rewrite(&self, mut hosts: Vec<(String, u16)>, txt: &[String]) -> AppResult<String> {
        let labels: Vec<&str> = self.host.split('.').collect();
        // Hosts must share the parent domain (or the host itself, for two labels)
        let domain = if labels.len() >= 3 {
            &labels[1..]
        } else {
            &labels[..]
        };
        for (host, _) in &hosts {
            let parts: Vec<&str> = host.split('.').collect();
            if !parts[1..].ends_with(domain) {
                return Err(AppError::msg(format!(
                    "SRV lookup for {} returned {host}, which isn't in the domain {}",
                    self.host,
                    domain.join(".")
                )));
            }
        }
        if hosts.is_empty() {
            return Err(AppError::msg(format!(
                "SRV lookup for {} returned no records",
                self.host
            )));
        }
        if let Some(max) = self
            .option("srvMaxHosts")
            .and_then(|v| v.parse::<usize>().ok())
            && max > 0
            && max < hosts.len()
        {
            // The spec wants a random subset, so each client spreads its load
            let start = (uuid::Uuid::new_v4().as_u128() % hosts.len() as u128) as usize;
            hosts.rotate_left(start);
            hosts.truncate(max);
        }

        let mut options: Vec<(&str, &str)> = self
            .options
            .iter()
            .filter(|(k, _)| {
                !k.eq_ignore_ascii_case("srvServiceName") && !k.eq_ignore_ascii_case("srvMaxHosts")
            })
            .copied()
            .collect();
        if txt.len() > 1 {
            return Err(AppError::msg(format!(
                "{} has more than one TXT record, which mongodb+srv doesn't allow",
                self.host
            )));
        }
        for pair in txt.iter().flat_map(|t| t.split('&')) {
            let Some((key, value)) = pair.split_once('=') else {
                return Err(AppError::msg(format!(
                    "The TXT record for {} has '{pair}', which isn't a key=value option",
                    self.host
                )));
            };
            if !["authSource", "replicaSet", "loadBalanced"]
                .iter()
                .any(|k| k.eq_ignore_ascii_case(key))
            {
                return Err(AppError::msg(format!(
                    "The TXT record for {} sets '{key}', but only authSource, replicaSet and \
                     loadBalanced are allowed",
                    self.host
                )));
            }
            // Options in the string win over the TXT record
            if self.option(key).is_none() {
                options.push((key, value));
            }
        }
        if self.option("tls").is_none() && self.option("ssl").is_none() {
            options.push(("tls", "true"));
        }

        let mut out = String::from("mongodb://");
        if let Some(userinfo) = self.userinfo {
            out.push_str(userinfo);
            out.push('@');
        }
        let seeds: Vec<String> = hosts.iter().map(|(h, p)| format!("{h}:{p}")).collect();
        out.push_str(&seeds.join(","));
        out.push_str(if self.path.is_empty() { "/" } else { self.path });
        let query: Vec<String> = options.iter().map(|(k, v)| format!("{k}={v}")).collect();
        if !query.is_empty() {
            out.push('?');
            out.push_str(&query.join("&"));
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hosts(names: &[&str]) -> Vec<(String, u16)> {
        names.iter().map(|n| (n.to_string(), 27017)).collect()
    }

    #[test]
    fn leaves_other_strings_alone() {
        assert_eq!(Srv::parse("mongodb://localhost:27017/"), None);
        assert_eq!(
            Srv::parse("mongodb+srv://cluster0.example.net:27017/"),
            None
        );
        assert_eq!(Srv::parse("mongodb+srv://localhost/"), None);
    }

    #[test]
    fn parses_user_path_and_options() {
        let srv = Srv::parse(
            "MONGODB+SRV://me:p%40ss@cluster0.ab1cd.mongodb.net/app?retryWrites=true&w=majority",
        )
        .unwrap();
        assert_eq!(srv.userinfo, Some("me:p%40ss"));
        assert_eq!(srv.host, "cluster0.ab1cd.mongodb.net");
        assert_eq!(srv.path, "/app");
        assert_eq!(srv.option("retrywrites"), Some("true"));
    }

    #[test]
    fn rewrites_atlas_string() {
        let srv = Srv::parse("mongodb+srv://me:pw@cluster0.ab1cd.mongodb.net/?appName=x").unwrap();
        let uri = srv
            .rewrite(
                hosts(&[
                    "ac-1-shard-00-00.ab1cd.mongodb.net",
                    "ac-1-shard-00-01.ab1cd.mongodb.net",
                ]),
                &["authSource=admin&replicaSet=atlas-xyz-shard-0".into()],
            )
            .unwrap();
        assert_eq!(
            uri,
            "mongodb://me:pw@ac-1-shard-00-00.ab1cd.mongodb.net:27017,\
             ac-1-shard-00-01.ab1cd.mongodb.net:27017/\
             ?appName=x&authSource=admin&replicaSet=atlas-xyz-shard-0&tls=true"
        );
    }

    #[test]
    fn string_options_win_over_txt() {
        let srv =
            Srv::parse("mongodb+srv://cluster0.example.net/db?authSource=other&tls=false").unwrap();
        let uri = srv
            .rewrite(hosts(&["a.example.net"]), &["authSource=admin".into()])
            .unwrap();
        assert_eq!(
            uri,
            "mongodb://a.example.net:27017/db?authSource=other&tls=false"
        );
    }

    #[test]
    fn rejects_hosts_outside_the_domain() {
        let srv = Srv::parse("mongodb+srv://cluster0.example.net/").unwrap();
        assert!(srv.rewrite(hosts(&["a.evil.com"]), &[]).is_err());
        let srv = Srv::parse("mongodb+srv://example.net/").unwrap();
        assert!(srv.rewrite(hosts(&["a.example.net"]), &[]).is_ok());
        assert!(srv.rewrite(hosts(&["example.net"]), &[]).is_err());
    }

    #[test]
    fn rejects_bad_txt_records() {
        let srv = Srv::parse("mongodb+srv://cluster0.example.net/").unwrap();
        let ok = hosts(&["a.example.net"]);
        assert!(srv.rewrite(ok.clone(), &["w=majority".into()]).is_err());
        assert!(srv.rewrite(ok.clone(), &["authSource".into()]).is_err());
        assert!(
            srv.rewrite(ok, &["authSource=a".into(), "replicaSet=b".into()])
                .is_err()
        );
    }

    #[test]
    fn caps_hosts_and_drops_srv_only_options() {
        let srv =
            Srv::parse("mongodb+srv://c.example.net/?srvMaxHosts=1&srvServiceName=custom").unwrap();
        assert_eq!(srv.option("srvServiceName"), Some("custom"));
        let uri = srv
            .rewrite(hosts(&["a.example.net", "b.example.net"]), &[])
            .unwrap();
        assert!(!uri.contains("srv"));
        assert_eq!(uri.matches(":27017").count(), 1);
    }
}
