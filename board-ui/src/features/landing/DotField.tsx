import { useEffect, useRef, useState } from "react";
import { useTheme } from "../../lib/theme";
import { startField, type Field } from "./dotField";

function prefersReducedMotion(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * The landing page's WebGL2 dot field, fixed behind the page. Under reduced motion, or without WebGL2,
 * it renders nothing and the body's static CSS dot grid shows on its own.
 */
export function DotField() {
  const [on, setOn] = useState(() => !prefersReducedMotion());
  const ref = useRef<HTMLCanvasElement>(null);
  const field = useRef<Field | null>(null);
  const theme = useTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    const canvas = ref.current;
    if (!on || !canvas) return;
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: false }) as WebGL2RenderingContext | null;
    if (!gl) {
      setOn(false);
      return;
    }
    try {
      field.current = startField(canvas, gl, { theme: themeRef.current });
    } catch {
      setOn(false);
      return;
    }
    return () => {
      field.current?.stop();
      field.current = null;
    };
  }, [on]);

  useEffect(() => {
    field.current?.setTheme(theme);
  }, [theme]);

  if (!on) return null;
  return <canvas aria-hidden="true" className="sf-landing-field" ref={ref} />;
}
