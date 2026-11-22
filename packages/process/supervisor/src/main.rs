//! BaboJUBot supervisor (#268): one per run. It starts the run's program, keeps the tree the program starts (its process group on
//! Linux and macOS, its job object on Windows) and ends that tree when the server asks or when the server is gone. The server talks
//! to it over the control channel (`protocol.rs`); what differs between systems is only how the tree is held and ended.

mod protocol;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
use unix as system;
#[cfg(windows)]
use windows as system;

fn main() {
    std::process::exit(system::run());
}
