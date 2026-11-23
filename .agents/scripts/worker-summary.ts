// How run-worker's summary shows a file a worker's tool reported. opencode reports it in its system's form (Windows:
// C:\…\src\a.ts), so the working folder is taken off by the system's path rules, not by a "/" prefix.
import path from "node:path";

/**
 * A reported file as the summary shows it: inside the working folder, relative to it with `/`; outside it (another folder or
 * another drive), exactly as reported. A path the tool already gave relative to the folder is shown with `/` too. `paths` is
 * the system's path rules (tests pass path.win32 or path.posix).
 */
export function shownPath(
  file: string,
  folder: string,
  paths: path.PlatformPath = path
): string {
  const relative = paths.isAbsolute(file) ? paths.relative(folder, file) : file;
  // relative() answers with `..` for a path above or beside the folder and with an absolute path for another drive.
  const outside =
    relative === ".." ||
    relative.startsWith(`..${paths.sep}`) ||
    paths.isAbsolute(relative);
  if (outside) return file;
  // The folder itself.
  if (relative === "") return ".";
  return relative.split(paths.sep).join("/");
}
