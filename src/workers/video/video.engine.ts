import {
	VideoBusInputCmd,
	VideoBusInputDataInit,
	VideoBusInputDataResize,
	VideoBusInputDataSettings,
	VideoBusInputPayload,
	VideoBusOutputCmd,
	VideoBusOutputPayload,
} from './video.model';
import { masks, xyWidthBits } from '../calc/calc.model';

/**
 * @author tknight-dev
 */

self.onmessage = (event: MessageEvent) => {
	const videoBusInputPayload: VideoBusInputPayload = event.data;

	switch (videoBusInputPayload.cmd) {
		case VideoBusInputCmd.DATA:
			VideoWorkerEngine.inputData(<Uint32Array>videoBusInputPayload.data);
			break;
		case VideoBusInputCmd.INIT:
			VideoWorkerEngine.initialize(self, <VideoBusInputDataInit>videoBusInputPayload.data);
			break;
		case VideoBusInputCmd.RESET:
			VideoWorkerEngine.inputReset(<Uint32Array>videoBusInputPayload.data);
			break;
		case VideoBusInputCmd.RESIZE:
			VideoWorkerEngine.inputResize(<VideoBusInputDataResize>videoBusInputPayload.data);
			break;
		case VideoBusInputCmd.SETTINGS:
			VideoWorkerEngine.inputSettings(<VideoBusInputDataSettings>videoBusInputPayload.data);
			break;
	}
};

enum CellState {
	ALIVE = 0,
	DEAD = 1,
	NONE = 2,
}

class VideoWorkerEngine {
	private static canvasOffscreen: OffscreenCanvas;
	private static canvasOffscreenContext: OffscreenCanvasRenderingContext2D;
	private static ctxHeight: number;
	private static ctxWidth: number;
	private static data: Uint32Array;
	private static dataNew: boolean;
	private static drawDeadCells: boolean;
	private static drawGrid: boolean;
	private static frameRequest: number;
	private static framesPerMillisecond: number;
	private static reset: boolean;
	private static resized: boolean;
	private static self: Window & typeof globalThis;
	private static settingsNew: boolean;
	private static tableSizeX: 48 | 112 | 240 | 496 | 1008 | 2032 | 8176 | 16368 | 32752;
	private static tableSizeY: number;

	public static async initialize(self: Window & typeof globalThis, data: VideoBusInputDataInit): Promise<void> {
		// Config
		VideoWorkerEngine.canvasOffscreen = data.canvasOffscreen;
		VideoWorkerEngine.canvasOffscreenContext = <OffscreenCanvasRenderingContext2D>data.canvasOffscreen.getContext('2d', {
			alpha: true,
			antialias: false,
			depth: true,
			desynchronized: true,
			powerPreference: 'high-performance',
			preserveDrawingBuffer: true,
		});
		VideoWorkerEngine.canvasOffscreenContext.imageSmoothingEnabled = false;
		VideoWorkerEngine.canvasOffscreenContext.shadowBlur = 0;
		VideoWorkerEngine.self = self;

		// Engines
		VideoWorkerEngine.inputData(data.life);
		VideoWorkerEngine.inputResize(data);
		VideoWorkerEngine.inputSettings(data);

		// Done
		if (VideoWorkerEngine.canvasOffscreenContext === null) {
			console.error('Engine > Video: failed acquire context');
			VideoWorkerEngine.post([
				{
					cmd: VideoBusOutputCmd.INIT_COMPLETE,
					data: false,
				},
			]);
		} else {
			let status: boolean = VideoWorkerEngine.renderBinder();
			VideoWorkerEngine.post([
				{
					cmd: VideoBusOutputCmd.INIT_COMPLETE,
					data: status,
				},
			]);

			if (status) {
				// Start rendering thread
				VideoWorkerEngine.frameRequest = requestAnimationFrame(VideoWorkerEngine.render);
			}
		}
	}

	public static inputData(data: Uint32Array): void {
		if (VideoWorkerEngine.reset) {
			return;
		}
		VideoWorkerEngine.data = data;
		VideoWorkerEngine.dataNew = true;
	}

	public static inputReset(data: Uint32Array): void {
		VideoWorkerEngine.inputData(data);
		VideoWorkerEngine.reset = true;
	}

	public static inputResize(data: VideoBusInputDataResize): void {
		let devicePixelRatio: number = data.devicePixelRatio,
			height: number = Math.floor(data.height * devicePixelRatio),
			width: number = Math.floor(data.width * devicePixelRatio);

		VideoWorkerEngine.ctxHeight = height;
		VideoWorkerEngine.ctxWidth = width;
		VideoWorkerEngine.resized = true;
	}

	public static inputSettings(data: VideoBusInputDataSettings): void {
		VideoWorkerEngine.drawDeadCells = data.drawDeadCells;
		VideoWorkerEngine.drawGrid = data.drawGrid;
		VideoWorkerEngine.framesPerMillisecond = (1000 / data.fps) | 0;
		VideoWorkerEngine.settingsNew = true;
		VideoWorkerEngine.tableSizeX = data.tableSizeX;
		VideoWorkerEngine.tableSizeY = (data.tableSizeX * 9) / 16;
	}

	private static post(VideoBusWorkerPayloads: VideoBusOutputPayload[]): void {
		VideoWorkerEngine.self.postMessage({
			payloads: VideoBusWorkerPayloads,
		});
	}

	private static render(timestampNow: number): void {}

	private static renderBinder(): boolean {
		let cache: boolean,
			cacheCanvasCellAlive: OffscreenCanvas = new OffscreenCanvas(1, 1),
			cacheCanvasCellAliveCtx: OffscreenCanvasRenderingContext2D,
			cacheCanvasCellDead: OffscreenCanvas = new OffscreenCanvas(1, 1),
			cacheCanvasCellDeadCtx: OffscreenCanvasRenderingContext2D,
			cacheCanvasGridHorizontal: OffscreenCanvas = new OffscreenCanvas(1, 1),
			cacheCanvasGridHorizontalCtx: OffscreenCanvasRenderingContext2D,
			cacheCanvasGrids: OffscreenCanvas = new OffscreenCanvas(1, 1),
			cacheCanvasGridsCtx: OffscreenCanvasRenderingContext2D,
			cacheCanvasGridVertical: OffscreenCanvas = new OffscreenCanvas(1, 1),
			cacheCanvasGridVerticalCtx: OffscreenCanvasRenderingContext2D,
			canvasOffscreen: OffscreenCanvas = VideoWorkerEngine.canvasOffscreen,
			canvasOffscreenContext: OffscreenCanvasRenderingContext2D = VideoWorkerEngine.canvasOffscreenContext,
			cellState: CellState,
			contextOptionsNoAlpha = {
				alpha: false,
				antialias: false,
				depth: true,
				desynchronized: true,
				powerPreference: 'high-performance',
				preserveDrawingBuffer: true,
			},
			data: Uint32Array,
			dataEff: Map<number, CellState> = new Map(),
			drawDeadCells: boolean,
			drawDeadCellsInversion: boolean, // true means remove non dead cells via clearRect
			drawGrid: boolean,
			frameCount: number = 0,
			frameTimestampDelta: number = 0,
			frameTimestampFPSThen: number = 0,
			frameTimestampThen: number = 0,
			pxCellSize: number,
			pxHeight: number,
			pxWidth: number,
			tableSizeX: number,
			x: number,
			xy: number,
			xyOnly: number,
			y: number;

		const { xyMask, xyValueAlive, yMask } = masks;

		cacheCanvasCellAliveCtx = <OffscreenCanvasRenderingContext2D>cacheCanvasCellAlive.getContext('2d', contextOptionsNoAlpha);
		cacheCanvasCellAliveCtx.imageSmoothingEnabled = false;
		cacheCanvasCellAliveCtx.shadowBlur = 0;

		cacheCanvasCellDeadCtx = <OffscreenCanvasRenderingContext2D>cacheCanvasCellDead.getContext('2d', contextOptionsNoAlpha);
		cacheCanvasCellDeadCtx.imageSmoothingEnabled = false;
		cacheCanvasCellDeadCtx.shadowBlur = 0;

		cacheCanvasGridHorizontalCtx = <OffscreenCanvasRenderingContext2D>cacheCanvasGridHorizontal.getContext('2d', contextOptionsNoAlpha);
		cacheCanvasGridHorizontalCtx.imageSmoothingEnabled = false;
		cacheCanvasGridHorizontalCtx.shadowBlur = 0;

		cacheCanvasGridsCtx = <OffscreenCanvasRenderingContext2D>cacheCanvasGrids.getContext('2d', {
			...contextOptionsNoAlpha,
			alpha: true,
		});
		cacheCanvasGridsCtx.imageSmoothingEnabled = false;
		cacheCanvasGridsCtx.shadowBlur = 0;

		cacheCanvasGridVerticalCtx = <OffscreenCanvasRenderingContext2D>cacheCanvasGridVertical.getContext('2d', contextOptionsNoAlpha);
		cacheCanvasGridVerticalCtx.imageSmoothingEnabled = false;
		cacheCanvasGridVerticalCtx.shadowBlur = 0;

		const render = (timestampNow: number) => {
			timestampNow |= 0;

			// Start the request for the next frame
			VideoWorkerEngine.frameRequest = requestAnimationFrame(render);
			frameTimestampDelta = timestampNow - frameTimestampThen;

			if (VideoWorkerEngine.reset || tableSizeX !== VideoWorkerEngine.tableSizeX) {
				VideoWorkerEngine.dataNew = true;

				cache = false;
				dataEff.clear();
				frameTimestampDelta = VideoWorkerEngine.framesPerMillisecond + 1;

				// Initialize effective data set for all possible positions and set to none
				for (x = 0; x < VideoWorkerEngine.tableSizeX; x++) {
					for (y = 0; y < VideoWorkerEngine.tableSizeY; y++) {
						dataEff.set((x << xyWidthBits) | y, CellState.NONE);
					}
				}
			}

			if (VideoWorkerEngine.resized || VideoWorkerEngine.settingsNew) {
				VideoWorkerEngine.resized = false;
				VideoWorkerEngine.settingsNew = false;

				cache = false;
				drawDeadCells = VideoWorkerEngine.drawDeadCells;
				drawGrid = VideoWorkerEngine.drawGrid;
				pxHeight = VideoWorkerEngine.ctxHeight;
				pxWidth = VideoWorkerEngine.ctxWidth;
				tableSizeX = VideoWorkerEngine.tableSizeX;

				pxCellSize = Math.round((pxWidth / tableSizeX) * 1000) / 1000;
				if (drawGrid && pxWidth / tableSizeX < 3) {
					drawGrid = false;
				}

				// console.log('pxCellSize', pxCellSize);
				// console.log('pxHeight', pxHeight);
				// console.log('pxWidth', pxWidth);

				canvasOffscreen.height = pxHeight;
				canvasOffscreen.width = pxWidth;

				cacheCanvasCellAlive.height = pxCellSize;
				cacheCanvasCellAlive.width = pxCellSize;
				cacheCanvasCellAliveCtx.fillStyle = 'rgb(0,255,0)';
				cacheCanvasCellAliveCtx.fillRect(0, 0, pxCellSize, pxCellSize);

				cacheCanvasCellDead.height = pxCellSize;
				cacheCanvasCellDead.width = pxCellSize;
				cacheCanvasCellDeadCtx.fillStyle = 'rgb(0,64,0)';
				cacheCanvasCellDeadCtx.fillRect(0, 0, pxCellSize, pxCellSize);

				if (drawGrid) {
					cacheCanvasGridHorizontal.height = 1;
					cacheCanvasGridHorizontal.width = pxWidth;
					cacheCanvasGridHorizontalCtx.fillStyle = 'rgba(255,255,255,0.25)';
					cacheCanvasGridHorizontalCtx.fillRect(0, 0, pxWidth, 1);

					cacheCanvasGridVertical.height = pxHeight;
					cacheCanvasGridVertical.width = 1;
					cacheCanvasGridVerticalCtx.fillStyle = cacheCanvasGridHorizontalCtx.fillStyle;
					cacheCanvasGridVerticalCtx.fillRect(0, 0, 1, pxHeight);

					cacheCanvasGrids.height = pxHeight;
					cacheCanvasGrids.width = pxWidth;

					for (y = 0; y < pxHeight; y += pxCellSize) {
						cacheCanvasGridsCtx.drawImage(cacheCanvasGridHorizontal, 0, y);
					}

					// Grid: Vertical
					for (x = 0; x < pxWidth; x += pxCellSize) {
						cacheCanvasGridsCtx.drawImage(cacheCanvasGridVertical, x, 0);
					}
				}
			}

			/**
			 * Render data at frames per ms rate
			 */
			if (frameTimestampDelta > VideoWorkerEngine.framesPerMillisecond) {
				frameTimestampThen = timestampNow - (frameTimestampDelta % VideoWorkerEngine.framesPerMillisecond);
				frameCount++;

				// Process Data
				if (VideoWorkerEngine.dataNew) {
					VideoWorkerEngine.dataNew = false;

					cache = false;
					data = VideoWorkerEngine.data;

					// Update the effective and record new changes
					for (xy of data) {
						cellState = (xy & xyValueAlive) !== 0 ? CellState.ALIVE : CellState.DEAD;
						xyOnly = xy & xyMask;

						dataEff.set(xyOnly, cellState);
					}

					if (data.length > dataEff.size / 2) {
						drawDeadCellsInversion = true;
					} else {
						drawDeadCellsInversion = false;
					}
				}

				// Draw Data
				if (!cache) {
					// Background
					if (drawDeadCells && drawDeadCellsInversion) {
						canvasOffscreenContext.fillStyle = 'rgb(0,64,0)';
						canvasOffscreenContext.fillRect(0, 0, pxWidth, pxHeight);
					} else {
						canvasOffscreenContext.clearRect(0, 0, pxWidth, pxHeight);
					}

					// Cells
					for ([xy, cellState] of dataEff) {
						if (drawDeadCells) {
							if (drawDeadCellsInversion) {
								// Draw alive cells and clear non-dead cells
								x = (xy >> xyWidthBits) & yMask;
								y = xy & yMask;

								if (cellState === CellState.ALIVE) {
									canvasOffscreenContext.drawImage(cacheCanvasCellAlive, x * pxCellSize, y * pxCellSize);
								} else if (cellState === CellState.NONE) {
									canvasOffscreenContext.clearRect(x * pxCellSize, y * pxCellSize, pxCellSize, pxCellSize);
								}
							} else if (cellState !== CellState.NONE) {
								// Draw dead or alive cells
								x = (xy >> xyWidthBits) & yMask;
								y = xy & yMask;

								canvasOffscreenContext.drawImage(
									cellState === CellState.ALIVE ? cacheCanvasCellAlive : cacheCanvasCellDead,
									x * pxCellSize,
									y * pxCellSize,
								);
							}
						} else if (cellState === CellState.ALIVE) {
							// Draw alive
							x = (xy >> xyWidthBits) & yMask;
							y = xy & yMask;
							canvasOffscreenContext.drawImage(cacheCanvasCellAlive, x * pxCellSize, y * pxCellSize);
						}
					}

					// Grid
					if (drawGrid) {
						canvasOffscreenContext.drawImage(cacheCanvasGrids, 0, 0);
					}

					cache = true;

					if (VideoWorkerEngine.reset) {
						VideoWorkerEngine.reset = false;

						VideoWorkerEngine.post([
							{
								cmd: VideoBusOutputCmd.RESET_COMPLETE,
								data: undefined,
							},
						]);
					}
				}
			}

			/**
			 * Send FPS to main thread every second
			 */
			if (timestampNow - frameTimestampFPSThen > 999) {
				VideoWorkerEngine.post([
					{
						cmd: VideoBusOutputCmd.FPS,
						data: frameCount,
					},
				]);
				frameCount = 0;
				frameTimestampFPSThen = timestampNow;
			}
		};
		VideoWorkerEngine.render = render;
		return true;
	}
}
