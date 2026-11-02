import type { ArtifactFile } from "@babojubot/contracts";

export const fileSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** Keep the suffix visible in a shrinking row; the full name remains its accessible name. */
export function ArtifactFilename({
  file,
  text,
}: {
  file: ArtifactFile;
  text: boolean;
}) {
  const chars = [...file.name];
  const tailLength = Math.min(12, Math.ceil(chars.length / 3));

  return (
    <span className="flex min-w-0 items-center gap-2" aria-label={file.name}>
      <svg
        aria-hidden="true"
        className="h-4 w-4 shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <path d="M6 2h8l4 4v16H6z M14 2v5h4" />
        {text && <path d="M9 12h6M9 16h6" />}
      </svg>
      <span aria-hidden="true" className="flex min-w-0">
        <span className="truncate">{chars.slice(0, -tailLength).join("")}</span>
        <span className="shrink-0">{chars.slice(-tailLength).join("")}</span>
      </span>
    </span>
  );
}

export function ArtifactFileMetadata({
  file,
  createdAt,
}: {
  file: ArtifactFile;
  createdAt: string;
}) {
  return (
    <dl
      aria-label="파일 정보"
      className="card mb-4 grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2 p-4 text-sm"
    >
      <dt>이름</dt>
      <dd className="break-all">{file.name}</dd>
      <dt>종류</dt>
      <dd className="break-all">{file.mediaType}</dd>
      <dt>크기</dt>
      <dd>{fileSize(file.size)}</dd>
      <dt>등록 시각</dt>
      <dd>{new Date(createdAt).toLocaleString("ko-KR")}</dd>
      <dt>원래 경로</dt>
      <dd className="break-all">{file.path}</dd>
    </dl>
  );
}
