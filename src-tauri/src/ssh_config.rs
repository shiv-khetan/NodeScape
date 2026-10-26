use crate::{
    contracts::{AppError, Target},
    transport::{execute, RunOpts},
};
use std::collections::HashMap;

pub async fn effective(target: &Target) -> Result<HashMap<String, String>, AppError> {
    let output = execute(target, None, RunOpts::default()).await?;
    let mut values = HashMap::new();
    for line in output.lines() {
        if let Some((key, value)) = line.split_once(' ') {
            // OpenSSH may emit repeated keys (e.g. identityfile); retain the first value.
            values
                .entry(key.to_owned())
                .or_insert_with(|| value.to_owned());
        }
    }
    Ok(values)
}
