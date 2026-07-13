// svg to png. uses @resvg/resvg-js, an optional native dependency that
// rasterizes svg without a headless browser. it is lazily imported and
// optional: if it is not installed the receipt still generates with the svg
// source and the png is simply omitted. this keeps the base install light and
// the generator robust.

export async function svgToPng(svg: string): Promise<Buffer | null> {
  try {
    const mod = await import("@resvg/resvg-js");
    const Resvg = (mod as { Resvg: new (svg: string, opts?: unknown) => { render(): { asPng(): Uint8Array } } })
      .Resvg;
    const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 820 } });
    const png = resvg.render().asPng();
    return Buffer.from(png);
  } catch {
    // resvg not available; png is best-effort.
    return null;
  }
}
