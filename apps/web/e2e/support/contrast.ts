import type { Page } from "@playwright/test";

/** 기준에 못 미친 글자 하나: 글, 잰 대비, 기준, 겹쳐 그린 글자·배경 색(sRGB), 글자 크기. */
export type LowContrast = {
  text: string;
  ratio: number;
  required: number;
  fg: string;
  bg: string;
  fontSize: string;
};

/**
 * 화면에 실제로 보이는 글자의 대비를 잰다(WCAG 2.2 1.4.3). 글자 색의 투명도, 조상의 배경색 겹침, 조상 `opacity`까지 반영해
 * 그려지는 색끼리 비교한다. 색은 canvas로 sRGB로 바꾸므로 oklch 같은 계산 색도 그대로 잰다.
 * 기준은 4.5:1, 큰 글자(24px 이상, 굵은 18.66px 이상)는 3:1이다. 화면 읽기 프로그램 전용(`sr-only`)·`aria-hidden` 장식·비활성 칸,
 * 배경이 그림·그라데이션인 글자, 잘림을 알리려 흐리게 덮은(mask) 글자는 재지 않는다.
 */
export function lowContrastTexts(page: Page): Promise<LowContrast[]> {
  return page.evaluate(async () => {
    // 들어오는 효과가 끝난 뒤의 색을 잰다. 끝없는 반복(spin·pulse)은 기다리지 않는다.
    await Promise.race([
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => undefined))
      ),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    type RGBA = [number, number, number, number];
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const rgba = (css: string): RGBA => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!, a! / 255];
    };
    const over = (top: RGBA, under: RGBA): RGBA => {
      const a = top[3];
      return [
        top[0] * a + under[0] * (1 - a),
        top[1] * a + under[1] * (1 - a),
        top[2] * a + under[2] * (1 - a),
        1,
      ];
    };
    const mix = (a: RGBA, b: RGBA, t: number): RGBA => [
      a[0] * t + b[0] * (1 - t),
      a[1] * t + b[1] * (1 - t),
      a[2] * t + b[2] * (1 - t),
      1,
    ];
    const luminance = ([r, g, b]: RGBA) => {
      const lin = (c: number) => {
        const s = c / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const ratio = (a: RGBA, b: RGBA) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    const rgbText = (c: RGBA) =>
      `rgb(${c
        .slice(0, 3)
        .map((v) => Math.round(v))
        .join(",")})`;

    const out = new Map<string, LowContrast>();
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      const el = node.parentElement;
      if (!text || !el) continue;
      if (
        el.closest(
          '[aria-hidden="true"], option, :disabled, [aria-disabled="true"]'
        )
      )
        continue;
      if (!el.checkVisibility({ visibilityProperty: true })) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) continue;
      // 조상 사슬(html → el)의 배경과 opacity.
      const chain: Element[] = [];
      for (let e: Element | null = el; e; e = e.parentElement) chain.unshift(e);
      const styles = chain.map((e) => getComputedStyle(e));
      if (
        styles.some(
          (s) =>
            s.backgroundImage !== "none" ||
            (s.maskImage && s.maskImage !== "none") ||
            s.clip === "rect(0px, 0px, 0px, 0px)"
        )
      )
        continue;
      const backdrop: RGBA[] = [[255, 255, 255, 1]];
      for (const s of styles)
        backdrop.push(over(rgba(s.backgroundColor), backdrop.at(-1)!));
      const own = styles.at(-1)!;
      let fg = over(rgba(own.color), backdrop.at(-1)!);
      let bg = backdrop.at(-1)!;
      for (let i = styles.length - 1; i >= 0; i--) {
        const o = Number(styles[i]!.opacity);
        if (o < 1) {
          fg = mix(fg, backdrop[i]!, o);
          bg = mix(bg, backdrop[i]!, o);
        }
      }
      const size = parseFloat(own.fontSize);
      const bold = Number(own.fontWeight) >= 700;
      const required = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      const measured = ratio(fg, bg);
      if (measured + 0.005 >= required) continue;
      const key = `${text.slice(0, 40)}|${rgbText(fg)}|${rgbText(bg)}`;
      if (!out.has(key))
        out.set(key, {
          text: text.slice(0, 60),
          ratio: Math.round(measured * 100) / 100,
          required,
          fg: rgbText(fg),
          bg: rgbText(bg),
          fontSize: own.fontSize,
        });
    }
    return [...out.values()];
  });
}
