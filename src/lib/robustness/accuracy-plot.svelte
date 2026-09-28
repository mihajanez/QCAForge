<script lang="ts">
	import { onDestroy, onMount } from "svelte";
	import { mode } from "mode-watcher";
	import {
		drawAccuracyPlot,
		type ColorScheme,
		type HoverInfo,
		type PlotMode,
		type PlotPalette,
	} from "./accuracy-plot";
	import { formatNumber, type AccuracyGrid } from "./robustness";

	interface Props {
		grid: AccuracyGrid;
		xLabel: string;
		yLabel: string;
		mode: PlotMode;
		colorScheme: ColorScheme;
		showValues: boolean;
		nominal?: { x: number; y?: number };
		selected?: { ix: number; iy: number };
		onSelect?: (ix: number, iy: number) => void;
	}

	let {
		grid,
		xLabel,
		yLabel,
		mode: plotMode,
		colorScheme,
		showValues,
		nominal,
		selected,
		onSelect,
	}: Props = $props();

	let container: HTMLDivElement;
	let svgElement: SVGSVGElement;
	let width = $state(0);
	let height = $state(0);
	let hover: HoverInfo | undefined = $state();
	let resizeObserver: ResizeObserver | undefined;

	function themeColor(variable: string, fallback: string): string {
		const value = getComputedStyle(document.documentElement)
			.getPropertyValue(variable)
			.trim();
		return value ? `hsl(${value})` : fallback;
	}

	function themePalette(): PlotPalette {
		return {
			background: themeColor("--background", "#fff"),
			foreground: themeColor("--foreground", "#111"),
			muted: themeColor("--muted", "#e5e5e5"),
			grid: themeColor("--border", "#d4d4d4"),
			nominal: "#e11d48",
			selection: themeColor("--foreground", "#111"),
			error: themeColor("--destructive", "#dc2626"),
		};
	}

	onMount(() => {
		resizeObserver = new ResizeObserver(() => {
			width = container.clientWidth;
			height = container.clientHeight;
		});
		resizeObserver.observe(container);
	});

	onDestroy(() => resizeObserver?.disconnect());

	$effect(() => {
		// Redraw on any option change, resize or theme switch.
		void mode.current;
		if (!svgElement || width <= 0 || height <= 0) return;
		drawAccuracyPlot(
			svgElement,
			width,
			height,
			{
				grid,
				xLabel,
				yLabel,
				mode: plotMode,
				colorScheme,
				showValues,
				nominal,
				selected,
				palette: themePalette(),
			},
			{
				onHover: (info) => (hover = info),
				onSelect,
			},
		);
	});
</script>

<div class="relative h-full w-full min-h-0" bind:this={container}>
	<svg bind:this={svgElement} class="absolute inset-0"></svg>
	{#if hover}
		<div
			class="pointer-events-none absolute z-10 rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
			style:left="{Math.min(hover.left + 12, width - 180)}px"
			style:top="{Math.max(hover.top - 60, 0)}px"
		>
			<div>{xLabel}: <b>{formatNumber(hover.x)}</b></div>
			{#if hover.y !== undefined}
				<div>{yLabel}: <b>{formatNumber(hover.y)}</b></div>
			{/if}
			{#if hover.point?.error}
				<div class="text-destructive">Error: {hover.point.error}</div>
			{:else if hover.accuracy !== null}
				<div>Accuracy: <b>{(hover.accuracy * 100).toFixed(1)} %</b></div>
			{:else}
				<div class="text-muted-foreground">Not simulated yet</div>
			{/if}
		</div>
	{/if}
</div>
