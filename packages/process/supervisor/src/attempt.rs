//! Steps that do not depend on each other are all tried, and their failures are kept (#274 external review 3, STD-4). The server's
//! `attemptAll` (`@babojubot/contracts`) does the same. A `?` between independent steps, such as the signals to different parts of a
//! tree, skips the steps after a failure; a failed signal must not keep the other parts from theirs, nor skip the end check.

use std::time::{Duration, Instant};

/// Joins the failures of steps that were all tried. Every result is taken, so an iterator that runs one step per item runs them all.
/// Only Unix signals several targets at once (the group and each orphan); Windows ends one job.
#[cfg(unix)]
pub fn all_of(results: impl IntoIterator<Item = Result<(), String>>) -> Result<(), String> {
    let failures: Vec<String> = results.into_iter().filter_map(Result::err).collect();
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

/// The failures seen along a stop, each kept once: a signal repeated on every look fails the same way each time.
#[derive(Default)]
pub struct Failures(Vec<String>);

impl Failures {
    pub fn note(&mut self, result: Result<(), String>) {
        if let Err(failure) = result
            && !self.0.contains(&failure)
        {
            self.0.push(failure);
        }
    }

    /// `<head> (<cause>; <failures>)`: what is left, why, and the failures on the way.
    pub fn reason(&self, head: &str, cause: &str) -> String {
        let mut parts = vec![cause.to_owned()];
        parts.extend(self.0.iter().cloned());
        format!("{head} ({})", parts.join("; "))
    }
}

/// What a bounded wait found when it ended: how many still run, or why that could not be told.
#[derive(Debug, PartialEq)]
pub enum Left {
    Count(usize),
    Unknown(String),
}

impl Left {
    pub fn is_empty(&self) -> bool {
        *self == Left::Count(0)
    }
}

/// Looks until nothing runs or until `limit`. A failed look is tried again until the limit: it tells nothing about whether the tree
/// ended. `between` runs between looks (a repeated signal) and its failures go to `failures`.
pub fn wait_until_empty(
    limit: Duration,
    mut look: impl FnMut() -> Result<usize, String>,
    mut between: impl FnMut() -> Result<(), String>,
    failures: &mut Failures,
) -> Left {
    let deadline = Instant::now() + limit;
    loop {
        let left = match look() {
            Ok(count) => Left::Count(count),
            Err(why) => Left::Unknown(why),
        };
        if left.is_empty() || Instant::now() >= deadline {
            return left;
        }
        failures.note(between());
        std::thread::sleep(crate::protocol::POLL);
    }
}

#[cfg(test)]
mod tests {
    use super::{Failures, Left, wait_until_empty};
    use std::cell::Cell;
    use std::time::Duration;

    #[cfg(unix)]
    #[test]
    fn every_step_runs_and_every_failure_is_kept() {
        use super::all_of;
        let ran = Cell::new(0);
        let step = |fails: bool| {
            ran.set(ran.get() + 1);
            if fails {
                Err(format!("step {} failed", ran.get()))
            } else {
                Ok(())
            }
        };
        assert_eq!(
            all_of([true, false, true].map(step)),
            Err("step 1 failed; step 3 failed".to_owned())
        );
        assert_eq!(ran.get(), 3);
        assert_eq!(all_of([Ok(()), Ok(())]), Ok(()));
    }

    #[test]
    fn a_failed_look_is_tried_again_until_the_limit() {
        let looks = Cell::new(0);
        let mut failures = Failures::default();
        let left = wait_until_empty(
            Duration::from_secs(5),
            || {
                looks.set(looks.get() + 1);
                if looks.get() == 1 {
                    Err("could not look".to_owned())
                } else {
                    Ok(0)
                }
            },
            || Ok(()),
            &mut failures,
        );
        assert_eq!(left, Left::Count(0));
        let left = wait_until_empty(
            Duration::ZERO,
            || Err("could not look".to_owned()),
            || Ok(()),
            &mut failures,
        );
        assert_eq!(left, Left::Unknown("could not look".to_owned()));
    }

    #[test]
    fn a_repeated_failure_is_kept_once() {
        let mut failures = Failures::default();
        failures.note(Err("refused".to_owned()));
        failures.note(Ok(()));
        failures.note(Err("refused".to_owned()));
        assert_eq!(
            failures.reason("1", "it did not end"),
            "1 (it did not end; refused)"
        );
    }
}
