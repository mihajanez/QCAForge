import * as d3 from "d3";
import type { AccuracyGrid, SweepPoint } from "./robustness";

export type PlotMode = "heatmap" | "contour";
export type ColorScheme = "viridis" | "cividis" | "magma" | "RdYlGn";

export const COLOR_SCHEMES: Record<ColorScheme, (t: number) => string> = {
	viridis: d3.interpolateViridis,
	cividis: d3.interpolateCividis,
	magma: d3.interpolateMagma,
	RdYlGn: d3.interpolateRdYlGn,
};

export interface PlotPalette {
	background: string;
	foreground: string;
	muted: string;
	grid: string;
	nominal: string;
	selection: string;
	error: string;
}

/** Black on white, used for exported figures regardless of the app theme. */
export const PRINT_PALETTE: PlotPalette = {
	background: "#ffffff",
	foreground: "#111111",
	muted: "#e5e5e5",
	grid: "#d4d4d4",
	nominal: "#e11d48",
	selection: "#111111",
	error: "#dc2626",
};

export interface PlotOptions {
	grid: AccuracyGrid;
	xLabel: string;
	yLabel: string;
	mode: PlotMode;
	colorScheme: ColorScheme;
	showValues: boolean;
	nominal?: { x: number; y?: number };
	selected?: { ix: number; iy: number };
	palette: PlotPalette;
	fontSize?: number;
}

export interface PlotHandlers {
	onHover?: (point: HoverInfo | undefined) => void;
	onSelect?: (ix: number, iy: number) => void;
}

export interface HoverInfo {
	ix: number;
	iy: number;
	x: number;
	y?: number;
	accuracy: number | null;
	point?: SweepPoint;
	/** position relative to the svg */
	left: number;
	top: number;
}

const tickFormat = d3.format("~g");

/** Cell edges halfway between neighbouring (possibly non-uniform) values. */
function cellEdges(values: number[]): number[] {
	if (values.length === 1) {
		const half = Math.abs(values[0]) * 0.05 || 0.5;
		return [values[0] - half, values[0] + half];
	}
	const edges = [values[0] - (values[1] - values[0]) / 2];
	for (let i = 1; i < values.length; i++)
		edges.push((values[i - 1] + values[i]) / 2);
	const n = values.length;
	edges.push(values[n - 1] + (values[n - 1] - values[n - 2]) / 2);
	return edges;
}

/** Index i such that values[i] <= v <= values[i + 1], for interpolation. */
function bracket(values: number[], v: number): [number, number] {
	let i = d3.bisectRight(values, v) - 1;
	i = Math.max(0, Math.min(values.length - 2, i));
	const span = values[i + 1] - values[i];
	return [i, span === 0 ? 0 : (v - values[i]) / span];
}

function bilinear(grid: AccuracyGrid, x: number, y: number): number {
	const ys = grid.ys!;
	const [i, tx] = bracket(grid.xs, x);
	const [j, ty] = bracket(ys, y);
	const v = (jj: number, ii: number) => grid.values[jj]?.[ii] ?? NaN;
	return (
		v(j, i) * (1 - tx) * (1 - ty) +
		v(j, i + 1) * tx * (1 - ty) +
		v(j + 1, i) * (1 - tx) * ty +
		v(j + 1, i + 1) * tx * ty
	);
}

function textColorFor(fill: string): string {
	const c = d3.color(fill)?.rgb();
	if (!c) return "#000";
	const luminance = (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
	return luminance > 0.55 ? "#000" : "#fff";
}

let clipCounter = 0;

/**
 * Draws the accuracy plot into `svgElement` (replacing its content). A
 * one-parameter sweep is drawn as a line plot, a two-parameter sweep as a
 * heatmap or filled contour plot with a color bar.
 */
export function drawAccuracyPlot(
	svgElement: SVGSVGElement,
	width: number,
	height: number,
	options: PlotOptions,
	handlers: PlotHandlers = {},
) {
	const { grid, palette } = options;
	const fontSize = options.fontSize ?? 12;
	const is2d = grid.ys !== undefined && grid.ys.length > 0;
	const color = COLOR_SCHEMES[options.colorScheme];

	const svg = d3.select(svgElement);
	svg.selectAll("*").remove();
	svg.attr("width", width)
		.attr("height", height)
		.attr("viewBox", `0 0 ${width} ${height}`)
		.attr("font-family", "sans-serif")
		.attr("font-size", fontSize);
	svg.append("rect")
		.attr("width", width)
		.attr("height", height)
		.attr("fill", palette.background);

	const margin = {
		top: 16,
		right: is2d ? 96 : 24,
		bottom: 44 + fontSize,
		left: 60 + fontSize,
	};
	const w = Math.max(10, width - margin.left - margin.right);
	const h = Math.max(10, height - margin.top - margin.bottom);
	const g = svg
		.append("g")
		.attr("transform", `translate(${margin.left},${margin.top})`);

	const clipId = `accuracy-plot-clip-${++clipCounter}`;
	g.append("clipPath")
		.attr("id", clipId)
		.append("rect")
		.attr("width", w)
		.attr("height", h);

	let xScale: d3.ScaleLinear<number, number>;
	let yScale: d3.ScaleLinear<number, number>;

	if (is2d) {
		const ys = grid.ys!;
		const xEdges = cellEdges(grid.xs);
		const yEdges = cellEdges(ys);
		xScale = d3
			.scaleLinear()
			.domain([xEdges[0], xEdges[xEdges.length - 1]])
			.range([0, w]);
		yScale = d3
			.scaleLinear()
			.domain([yEdges[0], yEdges[yEdges.length - 1]])
			.range([h, 0]);

		const plot = g.append("g").attr("clip-path", `url(#${clipId})`);
		const complete = grid.values.every((row) =>
			row.every((v) => v !== null),
		);

		if (options.mode === "contour" && complete && grid.xs.length > 1 && ys.length > 1) {
			const n = Math.min(200, Math.max(50, grid.xs.length * 8));
			const m = Math.min(200, Math.max(50, ys.length * 8));
			const x0 = grid.xs[0];
			const x1 = grid.xs[grid.xs.length - 1];
			const y0 = ys[0];
			const y1 = ys[ys.length - 1];
			const samples = new Array(n * m);
			for (let j = 0; j < m; j++)
				for (let i = 0; i < n; i++)
					samples[j * n + i] = bilinear(
						grid,
						x0 + ((x1 - x0) * i) / (n - 1),
						y0 + ((y1 - y0) * j) / (m - 1),
					);
			// The interpolated surface spans the outermost sample values.
			xScale.domain([x0, x1]);
			yScale.domain([y0, y1]);
			const contours = d3
				.contours()
				.size([n, m])
				.thresholds(d3.range(0, 1, 0.05))(samples);
			const project = d3.geoTransform({
				point(px, py) {
					// Contour coordinates put sample k at k + 0.5.
					const gx = Math.max(0, Math.min(n - 1, px - 0.5));
					const gy = Math.max(0, Math.min(m - 1, py - 0.5));
					this.stream.point(
						xScale(x0 + ((x1 - x0) * gx) / (n - 1)),
						yScale(y0 + ((y1 - y0) * gy) / (m - 1)),
					);
				},
			});
			plot.selectAll("path.contour")
				.data(contours)
				.join("path")
				.attr("class", "contour")
				.attr("d", d3.geoPath(project))
				.attr("fill", (d) => color(Math.min(1, d.value + 0.025)));
		} else {
			grid.values.forEach((row, iy) =>
				row.forEach((value, ix) => {
					const point = grid.points[iy][ix];
					const x = xScale(xEdges[ix]);
					const y = yScale(yEdges[iy + 1]);
					const cw = xScale(xEdges[ix + 1]) - x;
					const ch = yScale(yEdges[iy]) - y;
					const fill = value === null ? palette.muted : color(value);
					plot.append("rect")
						.attr("x", x)
						.attr("y", y)
						.attr("width", cw + 0.5)
						.attr("height", ch + 0.5)
						.attr("fill", fill);
					if (point?.error) {
						plot.append("text")
							.attr("x", x + cw / 2)
							.attr("y", y + ch / 2)
							.attr("text-anchor", "middle")
							.attr("dominant-baseline", "central")
							.attr("fill", palette.error)
							.attr("font-weight", "bold")
							.text("×");
					} else if (
						options.showValues &&
						value !== null &&
						cw > fontSize * 2.4 &&
						ch > fontSize * 1.2
					) {
						plot.append("text")
							.attr("x", x + cw / 2)
							.attr("y", y + ch / 2)
							.attr("text-anchor", "middle")
							.attr("dominant-baseline", "central")
							.attr("font-size", fontSize * 0.85)
							.attr("fill", textColorFor(fill))
							.text(value.toFixed(2));
					}
				}),
			);
		}

		if (options.selected) {
			const { ix, iy } = options.selected;
			if (ix < grid.xs.length && iy < ys.length) {
				const x = xScale(xEdges[ix]);
				const y = yScale(yEdges[iy + 1]);
				g.append("rect")
					.attr("x", x)
					.attr("y", y)
					.attr("width", xScale(xEdges[ix + 1]) - x)
					.attr("height", yScale(yEdges[iy]) - y)
					.attr("fill", "none")
					.attr("stroke", palette.selection)
					.attr("stroke-width", 2)
					.attr("clip-path", `url(#${clipId})`);
			}
		}

		// Color bar
		const barX = w + 24;
		const barW = 14;
		const gradientId = `${clipId}-gradient`;
		const gradient = g
			.append("defs")
			.append("linearGradient")
			.attr("id", gradientId)
			.attr("x1", 0)
			.attr("y1", 1)
			.attr("x2", 0)
			.attr("y2", 0);
		d3.range(0, 1.0001, 0.1).forEach((t) =>
			gradient
				.append("stop")
				.attr("offset", t)
				.attr("stop-color", color(t)),
		);
		g.append("rect")
			.attr("x", barX)
			.attr("width", barW)
			.attr("height", h)
			.attr("fill", `url(#${gradientId})`);
		const barScale = d3.scaleLinear().domain([0, 1]).range([h, 0]);
		const barAxis = g
			.append("g")
			.attr("transform", `translate(${barX + barW},0)`)
			.call(d3.axisRight(barScale).ticks(5).tickFormat(tickFormat));
		styleAxis(barAxis, palette);
		g.append("text")
			.attr("transform", `translate(${barX + barW + 44},${h / 2}) rotate(90)`)
			.attr("text-anchor", "middle")
			.attr("fill", palette.foreground)
			.text("Accuracy");
	} else {
		const values = grid.values[0] ?? [];
		const extent = d3.extent(grid.xs) as [number, number];
		const pad = (extent[1] - extent[0]) * 0.03 || Math.abs(extent[0]) * 0.05 || 0.5;
		xScale = d3
			.scaleLinear()
			.domain([extent[0] - pad, extent[1] + pad])
			.range([0, w]);
		yScale = d3.scaleLinear().domain([0, 1.05]).range([h, 0]);

		g.append("g")
			.selectAll("line")
			.data(yScale.ticks(5))
			.join("line")
			.attr("x1", 0)
			.attr("x2", w)
			.attr("y1", (d) => yScale(d))
			.attr("y2", (d) => yScale(d))
			.attr("stroke", palette.grid)
			.attr("stroke-dasharray", "2,3");

		const data = grid.xs.map((x, ix) => ({ x, ix, v: values[ix] }));
		g.append("path")
			.datum(data)
			.attr("fill", "none")
			.attr("stroke", palette.foreground)
			.attr("stroke-width", 1.5)
			.attr(
				"d",
				d3
					.line<{ x: number; v: number | null }>()
					.defined((d) => d.v !== null)
					.x((d) => xScale(d.x))
					.y((d) => yScale(d.v!)),
			);
		g.selectAll("circle.point")
			.data(data.filter((d) => d.v !== null))
			.join("circle")
			.attr("class", "point")
			.attr("cx", (d) => xScale(d.x))
			.attr("cy", (d) => yScale(d.v!))
			.attr("r", (d) => (options.selected?.ix === d.ix ? 6 : 4))
			.attr("fill", (d) => color(d.v!))
			.attr("stroke", (d) =>
				options.selected?.ix === d.ix ? palette.selection : palette.foreground,
			)
			.attr("stroke-width", (d) => (options.selected?.ix === d.ix ? 2 : 0.75));
		grid.points[0]?.forEach((point, ix) => {
			if (!point?.error) return;
			g.append("text")
				.attr("x", xScale(grid.xs[ix]))
				.attr("y", yScale(0))
				.attr("text-anchor", "middle")
				.attr("fill", palette.error)
				.attr("font-weight", "bold")
				.text("×");
		});
	}

	// Nominal design marker
	if (options.nominal) {
		const { x, y } = options.nominal;
		const [dx0, dx1] = xScale.domain();
		if (x >= Math.min(dx0, dx1) && x <= Math.max(dx0, dx1)) {
			if (is2d && y !== undefined) {
				const [dy0, dy1] = yScale.domain();
				if (y >= Math.min(dy0, dy1) && y <= Math.max(dy0, dy1)) {
					g.append("circle")
						.attr("cx", xScale(x))
						.attr("cy", yScale(y))
						.attr("r", 5)
						.attr("fill", palette.nominal)
						.attr("stroke", "#fff")
						.attr("stroke-width", 1.5);
					g.append("text")
						.attr("x", xScale(x) + 8)
						.attr("y", yScale(y) - 8)
						.attr("fill", palette.nominal)
						.attr("font-size", fontSize * 0.9)
						.attr("paint-order", "stroke")
						.attr("stroke", palette.background)
						.attr("stroke-width", 3)
						.text("Nominal");
				}
			} else if (!is2d) {
				g.append("line")
					.attr("x1", xScale(x))
					.attr("x2", xScale(x))
					.attr("y1", 0)
					.attr("y2", h)
					.attr("stroke", palette.nominal)
					.attr("stroke-dasharray", "5,4");
				g.append("text")
					.attr("x", xScale(x) + 4)
					.attr("y", 12)
					.attr("fill", palette.nominal)
					.attr("font-size", fontSize * 0.9)
					.text("Nominal");
			}
		}
	}

	// Axes
	const xAxis = g
		.append("g")
		.attr("transform", `translate(0,${h})`)
		.call(d3.axisBottom(xScale).ticks(Math.max(2, Math.floor(w / 80))).tickFormat(tickFormat));
	styleAxis(xAxis, palette);
	const yAxis = g
		.append("g")
		.call(d3.axisLeft(yScale).ticks(Math.max(2, Math.floor(h / 50))).tickFormat(tickFormat));
	styleAxis(yAxis, palette);

	g.append("text")
		.attr("x", w / 2)
		.attr("y", h + 34 + fontSize * 0.5)
		.attr("text-anchor", "middle")
		.attr("fill", palette.foreground)
		.text(options.xLabel);
	g.append("text")
		.attr("transform", `translate(${-48 - fontSize * 0.5},${h / 2}) rotate(-90)`)
		.attr("text-anchor", "middle")
		.attr("fill", palette.foreground)
		.text(is2d ? options.yLabel : "Accuracy");

	// Interaction: map the cursor to the nearest sweep point.
	if (handlers.onHover || handlers.onSelect) {
		const nearest = (event: MouseEvent) => {
			const [mx, my] = d3.pointer(event, g.node());
			const vx = xScale.invert(mx);
			const ix = d3.minIndex(grid.xs, (x) => Math.abs(x - vx));
			let iy = 0;
			if (is2d) {
				const vy = yScale.invert(my);
				iy = d3.minIndex(grid.ys!, (y) => Math.abs(y - vy));
			}
			return { ix, iy, mx, my };
		};
		g.append("rect")
			.attr("width", w)
			.attr("height", h)
			.attr("fill", "transparent")
			.style("cursor", "crosshair")
			.on("mousemove", (event: MouseEvent) => {
				const { ix, iy, mx, my } = nearest(event);
				handlers.onHover?.({
					ix,
					iy,
					x: grid.xs[ix],
					y: is2d ? grid.ys![iy] : undefined,
					accuracy: grid.values[iy]?.[ix] ?? null,
					point: grid.points[iy]?.[ix],
					left: mx + margin.left,
					top: my + margin.top,
				});
			})
			.on("mouseleave", () => handlers.onHover?.(undefined))
			.on("click", (event: MouseEvent) => {
				const { ix, iy } = nearest(event);
				handlers.onSelect?.(ix, iy);
			});
	}
}

function styleAxis(
	axis: d3.Selection<SVGGElement, unknown, null, undefined>,
	palette: PlotPalette,
) {
	axis.selectAll("path, line").attr("stroke", palette.foreground);
	axis.selectAll("text").attr("fill", palette.foreground);
	axis.attr("font-size", null).attr("font-family", null);
}

/** Renders the plot off-screen with the print palette and returns SVG markup. */
export function renderAccuracyPlotSvg(
	width: number,
	height: number,
	options: Omit<PlotOptions, "palette">,
): string {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
	drawAccuracyPlot(svg, width, height, {
		...options,
		palette: PRINT_PALETTE,
		selected: undefined,
	});
	return new XMLSerializer().serializeToString(svg);
}

export async function svgToPng(
	svgMarkup: string,
	width: number,
	height: number,
	scale = 3,
): Promise<Uint8Array> {
	const url = URL.createObjectURL(
		new Blob([svgMarkup], { type: "image/svg+xml" }),
	);
	try {
		const image = new Image();
		await new Promise<void>((resolve, reject) => {
			image.onload = () => resolve();
			image.onerror = () => reject(new Error("Could not render figure"));
			image.src = url;
		});
		const canvas = document.createElement("canvas");
		canvas.width = width * scale;
		canvas.height = height * scale;
		const context = canvas.getContext("2d")!;
		context.scale(scale, scale);
		context.drawImage(image, 0, 0, width, height);
		const blob = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob(resolve, "image/png"),
		);
		if (!blob) throw new Error("Could not encode PNG");
		return new Uint8Array(await blob.arrayBuffer());
	} finally {
		URL.revokeObjectURL(url);
	}
}
