use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

pub fn secret() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
pub fn digest(value: &str) -> String {
    Sha256::digest(value.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[derive(Clone, Serialize)]
pub struct Client {
    pub id: String,
    pub name: String,
}
struct Grant {
    client: Client,
    expires: Instant,
}

pub struct Authorization {
    access_digest: String,
    grants: HashMap<String, Grant>,
    attempts: (Instant, u32),
}

impl Authorization {
    pub fn new(code: &str) -> Self {
        Self {
            access_digest: digest(code),
            grants: HashMap::new(),
            attempts: (Instant::now(), 0),
        }
    }
    pub fn login(&mut self, code: &str, name: &str) -> Result<(String, Client), &'static str> {
        if self.attempts.0.elapsed() >= Duration::from_secs(30) {
            self.attempts = (Instant::now(), 0);
        }
        if self.attempts.1 >= 10 {
            return Err("Too many attempts; wait 30 seconds");
        }
        self.attempts.1 += 1;
        if digest(code) != self.access_digest {
            return Err("Invalid access code");
        }
        self.prune();
        if self.grants.len() >= 16 {
            return Err("Browser limit reached; revoke an existing browser");
        }
        let token = secret();
        let client = Client {
            id: format!("remote-{}", uuid::Uuid::new_v4().simple()),
            name: name.chars().take(80).collect(),
        };
        self.grants.insert(
            digest(&token),
            Grant {
                client: client.clone(),
                expires: Instant::now() + Duration::from_secs(8 * 3600),
            },
        );
        Ok((token, client))
    }
    fn prune(&mut self) {
        self.grants.retain(|_, g| g.expires > Instant::now());
    }
    pub fn client(&mut self, token: &str) -> Option<Client> {
        self.prune();
        self.grants.get(&digest(token)).map(|g| g.client.clone())
    }
    pub fn clients(&mut self) -> Vec<Client> {
        self.prune();
        self.grants.values().map(|g| g.client.clone()).collect()
    }
    pub fn revoke(&mut self, id: &str) {
        self.grants.retain(|_, g| g.client.id != id);
    }
    pub fn contains(&mut self, id: &str) -> bool {
        self.prune();
        self.grants.values().any(|g| g.client.id == id)
    }
    pub fn clear(&mut self) {
        self.grants.clear();
        // A socket accepted before shutdown can still finish an HTTP request.
        // Removing the code as well prevents issuing a new grant on that socket.
        self.access_digest.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stopping_invalidates_the_access_code_and_existing_tokens() {
        let mut auth = Authorization::new("old-code");
        let (token, _) = auth.login("old-code", "browser").unwrap();
        auth.clear();
        assert!(auth.client(&token).is_none());
        assert!(auth.login("old-code", "browser").is_err());
    }
}
