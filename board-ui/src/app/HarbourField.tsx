import { useEffect, useRef } from "react";

/** A decorative shader field; the CSS grid remains when WebGL is unavailable. */
export function HarbourField() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || typeof WebGLRenderingContext === "undefined") return;
    const gl = canvas.getContext("webgl", { alpha: true, antialias: false, powerPreference: "low-power" });
    if (!gl) return;
    const shaders: WebGLShader[] = [];
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
    };
    const vertex = compile(gl.VERTEX_SHADER, "attribute vec2 position; void main(){gl_Position=vec4(position,0.,1.);}");
    const fragment = compile(gl.FRAGMENT_SHADER, `precision mediump float;
      uniform vec2 resolution; uniform vec2 pointer; uniform float time;
      void main(){
        vec2 uv=gl_FragCoord.xy/resolution;
        float depth=uv.y+.12;
        vec2 plane=vec2((uv.x-.5+pointer.x*.015)/depth,1./depth);
        vec2 lines=abs(fract(plane*vec2(15.,9.))-.5);
        float grid=1.-smoothstep(.012,.038,min(lines.x,lines.y));
        float fade=pow(1.-uv.y,2.)*.06;
        float pulse=.9+sin(time*.24)*.1;
        float alpha=grid*fade*pulse;
        gl_FragColor=vec4(vec3(.52,.58,.62)*alpha,alpha);
      }`);
    const program = gl.createProgram();
    const buffer = gl.createBuffer();
    let frame = 0;
    if (vertex && fragment && program && buffer) {
      gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
      if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
        gl.useProgram(program); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
        const position = gl.getAttribLocation(program, "position");
        gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
        const resolution = gl.getUniformLocation(program, "resolution");
        const time = gl.getUniformLocation(program, "time");
        const pointer = gl.getUniformLocation(program, "pointer");
        const reduced = matchMedia("(prefers-reduced-motion: reduce)");
        let drift = 0;
        const move = (event: PointerEvent) => { drift = event.clientX / innerWidth - .5; };
        const draw = (now: number) => {
          const width = Math.max(1, Math.floor(innerWidth / 2));
          const height = Math.max(1, Math.floor(innerHeight / 2));
          if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
          gl.viewport(0, 0, canvas.width, canvas.height);
          gl.uniform2f(resolution, canvas.width, canvas.height); gl.uniform1f(time, reduced.matches ? 0 : now / 1000);
          gl.uniform2f(pointer, reduced.matches ? 0 : drift, 0); gl.drawArrays(gl.TRIANGLES, 0, 6);
        };
        const animate = (now: number) => { if (!document.hidden) draw(now); frame = requestAnimationFrame(animate); };
        const start = () => { cancelAnimationFrame(frame); draw(0); if (!reduced.matches) frame = requestAnimationFrame(animate); };
        start();
        window.addEventListener("pointermove", move, { passive: true });
        window.addEventListener("resize", start); reduced.addEventListener("change", start);
        return () => {
          cancelAnimationFrame(frame); window.removeEventListener("pointermove", move); window.removeEventListener("resize", start);
          reduced.removeEventListener("change", start); shaders.forEach((shader) => gl.deleteShader(shader));
          gl.deleteBuffer(buffer); gl.deleteProgram(program);
        };
      }
    }
    shaders.forEach((shader) => gl.deleteShader(shader)); gl.deleteBuffer(buffer); gl.deleteProgram(program);
  }, []);
  return <div className="sf-harbour-field" aria-hidden="true"><canvas ref={ref} /></div>;
}
