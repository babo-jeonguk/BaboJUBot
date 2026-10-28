import type {
  AgentAppearance,
  AgentDetail,
  faceAccessories,
  faceColors,
  faceEyes,
  faceMouths,
} from "@babojubot/contracts";
import { useEffect, useId, useRef } from "react";
import "./agent-face.css";

/**
 * 에이전트 얼굴: 저장한 프리셋 조합(contracts `AgentAppearance`)을 SVG로 그린다.
 * 가만히 있을 때 눈을 깜빡이고, 포인터가 가까이 오면 눈동자가 따라보며, 표정은 에이전트 상태를 따른다.
 * 움직임 줄이기 설정이면 표정만 바꾸고 움직이지 않는다.
 */

/** 표정. 대기는 평온, 실행 중은 말하며 들썩임, 마지막 실행 시도 실패는 걱정, 일시정지는 졸음. */
export type FaceMood = "idle" | "working" | "worried" | "sleepy";

export function faceMoodOf(
  agent: Pick<AgentDetail, "status" | "paused" | "recentRuns"> | undefined
): FaceMood {
  if (!agent) return "idle";
  if (agent.paused) return "sleepy";
  if (agent.status === "running") return "working";
  return agent.recentRuns[0]?.status === "failed" ? "worried" : "idle";
}

type FaceColor = (typeof faceColors)[number];
export const faceColorStyle: Record<
  FaceColor,
  { label: string; fill: string; shade: string }
> = {
  sky: { label: "하늘색", fill: "#9ccfff", shade: "#5fa8ee" },
  mint: { label: "민트색", fill: "#9be6c6", shade: "#4fbf98" },
  peach: { label: "복숭아색", fill: "#ffc6a3", shade: "#ee9266" },
  lilac: { label: "라벤더색", fill: "#d3c0ff", shade: "#9d82ea" },
  lemon: { label: "레몬색", fill: "#ffe58a", shade: "#dfb53a" },
  rose: { label: "장미색", fill: "#ffb3c8", shade: "#e8739a" },
  sand: { label: "모래색", fill: "#ecd8b8", shade: "#c4a172" },
  slate: { label: "회색", fill: "#c4ccd8", shade: "#8592a6" },
};
export const faceEyeLabel: Record<(typeof faceEyes)[number], string> = {
  round: "동그란 눈",
  dot: "점 눈",
  oval: "길쭉한 눈",
  sparkle: "반짝이는 눈",
};
export const faceMouthLabel: Record<(typeof faceMouths)[number], string> = {
  smile: "미소",
  grin: "활짝 웃는 입",
  flat: "덤덤한 입",
  small: "작은 입",
};
export const faceAccessoryLabel: Record<
  (typeof faceAccessories)[number],
  string
> = {
  none: "없음",
  glasses: "안경",
  antenna: "안테나",
  headphones: "헤드폰",
  sprout: "새싹",
};

const ink = "#2b2f3a";
const eyeX = [36, 64] as const;
const eyeY = 54;
/** 눈동자가 움직일 수 있는 거리(viewBox 단위). */
const lookRange = { round: 3.6, dot: 3, oval: 2.6, sparkle: 2.4 } as const;
/** 이 거리(px) 안의 포인터만 따라본다. */
const lookRadius = 260;

export function AgentFace({
  appearance,
  mood = "idle",
  size = 40,
  label,
  seed = "",
  track = true,
}: {
  appearance: AgentAppearance;
  mood?: FaceMood;
  size?: number;
  /** 있으면 그림으로 읽히고, 없으면 옆 글자가 이름을 알리는 장식이다. */
  label?: string;
  /** 깜빡임 박자를 얼굴마다 다르게 하는 값(에이전트 ID 등). */
  seed?: string;
  /** 포인터 따라보기. 작은 목록 아이콘처럼 많이 모인 곳에서는 끈다. */
  track?: boolean;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const clip = useId();
  useLookAt(ref, track && mood !== "sleepy", lookRange[appearance.eyes]);
  const color = faceColorStyle[appearance.color];
  const beat = hashOf(seed);
  return (
    <svg
      ref={ref}
      className="face"
      data-mood={mood}
      data-color={appearance.color}
      data-eyes={appearance.eyes}
      data-mouth={appearance.mouth}
      data-accessory={appearance.accessory}
      viewBox="0 0 100 100"
      width={size}
      height={size}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={
        {
          "--blink-duration": `${3.8 + (beat % 23) / 10}s`,
          "--blink-delay": `-${(beat % 37) / 10}s`,
        } as React.CSSProperties
      }
    >
      <g className="face-body">
        {appearance.accessory === "headphones" && (
          <path
            d="M14 56 C14 22 86 22 86 56"
            fill="none"
            stroke={ink}
            strokeWidth="5"
            strokeLinecap="round"
          />
        )}
        {appearance.accessory === "antenna" && (
          <g>
            <line
              x1="50"
              y1="20"
              x2="50"
              y2="8"
              stroke={ink}
              strokeWidth="2.5"
              strokeLinecap="round"
            />
            <circle
              className="face-antenna-tip"
              cx="50"
              cy="6"
              r="4.5"
              fill={color.shade}
              stroke={ink}
              strokeWidth="2"
            />
          </g>
        )}
        {appearance.accessory === "sprout" && (
          <g stroke="#2f855a" strokeWidth="2" strokeLinejoin="round">
            <line x1="50" y1="20" x2="50" y2="11" strokeLinecap="round" />
            <path
              d="M50 13 C44 4 36 7 37 11 C40 15 47 15 50 13 Z"
              fill="#68d391"
            />
            <path
              d="M50 12 C55 3 64 5 63 9 C61 13 54 14 50 12 Z"
              fill="#68d391"
            />
          </g>
        )}
        <clipPath id={clip}>
          <circle cx="50" cy="57" r="37" />
        </clipPath>
        <circle cx="50" cy="57" r="37" fill={color.fill} />
        <ellipse
          cx="50"
          cy="96"
          rx="44"
          ry="16"
          fill={color.shade}
          opacity="0.35"
          clipPath={`url(#${clip})`}
        />
        <circle
          cx="50"
          cy="57"
          r="37"
          fill="none"
          stroke={color.shade}
          strokeWidth="2.5"
        />
        <ellipse
          cx="26"
          cy="67"
          rx="6"
          ry="3.6"
          fill="#ff7a9a"
          opacity="0.32"
        />
        <ellipse
          cx="74"
          cy="67"
          rx="6"
          ry="3.6"
          fill="#ff7a9a"
          opacity="0.32"
        />
        {appearance.accessory === "headphones" && (
          <g fill={color.shade} stroke={ink} strokeWidth="2.5">
            <rect x="7" y="47" width="11" height="20" rx="5" />
            <rect x="82" y="47" width="11" height="20" rx="5" />
          </g>
        )}
        <Brows mood={mood} />
        {eyeX.map((x) => (
          <Eye key={x} x={x} kind={appearance.eyes} mood={mood} />
        ))}
        {appearance.accessory === "glasses" && (
          <g fill="none" stroke={ink} strokeWidth="2.4">
            <circle cx={eyeX[0]} cy={eyeY} r="11" />
            <circle cx={eyeX[1]} cy={eyeY} r="11" />
            <path d="M47 53 Q50 50 53 53" />
            <path d="M25 52 L14 48 M75 52 L86 48" />
          </g>
        )}
        <Mouth kind={appearance.mouth} mood={mood} />
      </g>
      {mood === "sleepy" && (
        <text
          className="face-z"
          x="78"
          y="20"
          fontSize="16"
          fontWeight="700"
          fill={ink}
          fontFamily="system-ui, sans-serif"
        >
          z
        </text>
      )}
    </svg>
  );
}

function Brows({ mood }: { mood: FaceMood }) {
  if (mood === "worried")
    return (
      <g stroke={ink} strokeWidth="2.6" strokeLinecap="round">
        <path d="M28 41 L42 37" />
        <path d="M72 41 L58 37" />
      </g>
    );
  if (mood === "working")
    return (
      <g stroke={ink} strokeWidth="2.4" strokeLinecap="round" opacity="0.8">
        <path d="M29 39 Q36 36 43 39" />
        <path d="M57 39 Q64 36 71 39" />
      </g>
    );
  return null;
}

function Eye({
  x,
  kind,
  mood,
}: {
  x: number;
  kind: AgentAppearance["eyes"];
  mood: FaceMood;
}) {
  if (mood === "sleepy")
    return (
      <path
        d={`M${x - 6} ${eyeY} Q${x} ${eyeY + 5} ${x + 6} ${eyeY}`}
        fill="none"
        stroke={ink}
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    );
  const down = mood === "worried" ? 1.5 : 0;
  return (
    <g className="face-eye">
      {kind === "round" && (
        <ellipse
          cx={x}
          cy={eyeY}
          rx="8.5"
          ry="9"
          fill="#fff"
          stroke={ink}
          strokeWidth="1.6"
        />
      )}
      <g className="face-pupil">
        {kind === "round" && (
          <>
            <circle cx={x} cy={eyeY + down} r="4.4" fill={ink} />
            <circle cx={x + 1.6} cy={eyeY - 1.6 + down} r="1.4" fill="#fff" />
          </>
        )}
        {kind === "dot" && (
          <circle cx={x} cy={eyeY + down} r="4.2" fill={ink} />
        )}
        {kind === "oval" && (
          <ellipse cx={x} cy={eyeY + down} rx="3.8" ry="6.4" fill={ink} />
        )}
        {kind === "sparkle" && (
          <>
            <circle cx={x} cy={eyeY + down} r="6.2" fill={ink} />
            <circle cx={x + 2.2} cy={eyeY - 2.2 + down} r="2" fill="#fff" />
            <circle cx={x - 2} cy={eyeY + 2.4 + down} r="1" fill="#fff" />
          </>
        )}
      </g>
    </g>
  );
}

function Mouth({
  kind,
  mood,
}: {
  kind: AgentAppearance["mouth"];
  mood: FaceMood;
}) {
  const line = {
    fill: "none",
    stroke: ink,
    strokeWidth: 2.8,
    strokeLinecap: "round" as const,
  };
  if (mood === "working")
    return (
      <ellipse
        className="face-talk"
        cx="50"
        cy="74"
        rx="5.5"
        ry="4.5"
        fill={ink}
      />
    );
  if (mood === "worried")
    return <path d="M41 77 Q45.5 72 50 75 Q54.5 72 59 77" {...line} />;
  if (mood === "sleepy")
    return <path d="M46 75 Q50 77.5 54 75" {...line} strokeWidth={2.4} />;
  switch (kind) {
    case "smile":
      return <path d="M40 71 Q50 80 60 71" {...line} />;
    case "grin":
      return (
        <g>
          <path d="M38 69 Q50 86 62 69 Z" fill={ink} strokeLinejoin="round" />
          <path d="M44 77.5 Q50 74 56 77.5 Q50 81.5 44 77.5 Z" fill="#ff8fa3" />
        </g>
      );
    case "flat":
      return <path d="M42 74 L58 74" {...line} />;
    case "small":
      return <ellipse cx="50" cy="74" rx="3.4" ry="3.8" fill={ink} />;
  }
}

function hashOf(seed: string) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

// ---------- 포인터 따라보기 ----------

type Watcher = (x: number, y: number) => void;
const watchers = new Set<Watcher>();
let frame = 0;
let last: { x: number; y: number } | undefined;
const onMove = (event: PointerEvent) => {
  last = { x: event.clientX, y: event.clientY };
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (last) for (const watch of watchers) watch(last.x, last.y);
  });
};

/** 창 하나에 포인터 listener 하나를 두고, 얼굴마다 가까운 포인터 쪽으로 눈동자를 옮긴다. 멀어지면 가운데로 돌아온다. */
function useLookAt(
  ref: React.RefObject<SVGSVGElement | null>,
  enabled: boolean,
  range: number
) {
  useEffect(() => {
    const svg = ref.current;
    if (!enabled || !svg) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const pupils = () => svg.querySelectorAll<SVGGElement>(".face-pupil");
    const watch: Watcher = (px, py) => {
      const box = svg.getBoundingClientRect();
      if (!box.width) return;
      const dx = px - (box.left + box.width / 2);
      const dy = py - (box.top + box.height / 2);
      const distance = Math.hypot(dx, dy);
      if (distance > lookRadius + box.width) {
        svg.removeAttribute("data-tracking");
        pupils().forEach((p) => (p.style.transform = ""));
        return;
      }
      const reach = Math.min(1, distance / Math.max(box.width, 24));
      const angle = Math.atan2(dy, dx);
      // SVG 요소의 CSS transform 길이는 viewBox 단위다.
      const tx = (Math.cos(angle) * range * reach).toFixed(2);
      const ty = (Math.sin(angle) * range * reach).toFixed(2);
      svg.setAttribute("data-tracking", "");
      pupils().forEach(
        (p) => (p.style.transform = `translate(${tx}px, ${ty}px)`)
      );
    };
    watchers.add(watch);
    if (watchers.size === 1)
      window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      watchers.delete(watch);
      svg.removeAttribute("data-tracking");
      pupils().forEach((p) => (p.style.transform = ""));
      if (!watchers.size) {
        window.removeEventListener("pointermove", onMove);
        cancelAnimationFrame(frame);
        frame = 0;
      }
    };
  }, [ref, enabled, range]);
}
