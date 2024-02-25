// driver/driver.ts - Mapping from engines to Kwin API

import { TilingEngine, Tile, Client, EngineCapability, EngineType, EngineConfig } from "../engine";
import { Direction } from "../util/geometry";
import { GSize, GPoint, DirectionTools } from "../util/geometry";
import { InsertionPoint } from "../util/config";
import * as Kwin from "kwin-api";
import BiMap from "mnemonist/bi-map";
import Queue from "mnemonist/queue";
import { Log } from "../util/log";
import { Config } from "../util/config";
import { Controller } from "../controller";

export class TilingDriver {
    engine: TilingEngine;
    engineType: EngineType;
    
    private logger: Log;
    private config: Config;
    private ctrl: Controller;

    tiles: BiMap<Kwin.Tile, Tile> = new BiMap();
    clients: BiMap<Kwin.Window, Client> = new BiMap();
    // windows that have no associated tile but are still in an engine go here
    untiledWindows: Kwin.Window[] = [];
    
    get engineConfig(): EngineConfig {
        return {
            engineType: this.engineType,
            insertionPoint: this.engine.config.insertionPoint,
            rotateLayout: this.engine.config.rotateLayout
        };
    }

    constructor(
        engine: TilingEngine,
        engineType: EngineType,
        ctrl: Controller,
    ) {
        this.engine = engine;
        this.engineType = engineType;
        this.ctrl = ctrl;
        this.logger = ctrl.logger;
        this.config = ctrl.config;
    }

    switchEngine(engine: TilingEngine, engineType: EngineType): void {
        this.engine = engine;
        this.engineType = engineType;
        try {
            for (const client of this.clients.values()) {
                this.engine.addClient(client);
            }
            this.engine.buildLayout();
        } catch (e) {
            this.logger.error(e);
        }
    }

    buildLayout(rootTile: Kwin.Tile): void {
        // clear root tile
        while (rootTile.tiles.length > 0) {
            rootTile.tiles[0].remove();
        }
        this.tiles.clear();
        this.untiledWindows = [];
        for (const client of this.engine.untiledClients) {
            const window = this.clients.inverse.get(client);
            if (window != null) {
                this.untiledWindows.push(window);
            }
        }

        // for maximizing single, sometimes engines can create overlapping root tiles so find the real root
        let realRootTile: Tile = this.engine.rootTile;
        while (realRootTile.tiles.length == 1 && realRootTile.client == null) {
            realRootTile = realRootTile.tiles[0];
        }
        // if a root tile client exists, just maximize it. there shouldnt be one if roottile has children
        if (realRootTile.client != null && this.config.maximizeSingle) {
            const window = this.clients.inverse.get(realRootTile.client);
            if (window == undefined) {
                return;
            }
            window.tile = null;
            window.setMaximize(true, true);
            return;
        }
        const queue: Queue<Tile> = new Queue();
        queue.enqueue(realRootTile);
        this.tiles.set(rootTile, realRootTile);
        while (queue.size > 0) {
            const tile = queue.dequeue()!;
            const kwinTile = this.tiles.inverse.get(tile)!;
            this.ctrl.managedTiles.add(kwinTile);
            kwinTile.layoutDirection = tile.layoutDirection;
            // 1 is vertical, 2 is horizontal
            const horizontal = kwinTile.layoutDirection == 1;
            const tilesLen = tile.tiles.length;
            if (tilesLen > 1) {
                for (let i = 0; i < tilesLen; i += 1) {
                    // tiling has weird splitting mechanics, so hopefully this code can help with that
                    if (i == 0) {
                        kwinTile.split(tile.layoutDirection);
                    } else if (i > 1) {
                        kwinTile.tiles[i - 1].split(tile.layoutDirection);
                    }
                    if (horizontal && i > 0) {
                        kwinTile.tiles[i - 1].relativeGeometry.width =
                            kwinTile.relativeGeometry.width / tilesLen;
                    } else if (i > 0) {
                        kwinTile.tiles[i - 1].relativeGeometry.height =
                            kwinTile.relativeGeometry.height / tilesLen;
                    }
                    // evenly distribute tile sizes before doing custom resizing
                    this.tiles.set(kwinTile.tiles[i], tile.tiles[i]);
                    queue.enqueue(tile.tiles[i]);
                }
            }
            // if there is one child tile, replace this tile with the child tile
            else if (tilesLen == 1) {
                this.tiles.set(kwinTile, tile.tiles[0]);
                queue.enqueue(tile.tiles[0]);
            }
            if (tile.client != null) {
                const window = this.clients.inverse.get(tile.client);
                if (window == undefined) {
                    this.logger.error("Client", tile.client.name, "does not exist");
                    return;
                }
                const extensions = this.ctrl.windowExtensions.get(window)!;
                // set some properties before setting tile to make sure client shows up
                window.minimized = false;
                window.fullScreen = false;
                if (extensions.maximized) {
                    window.setMaximize(false, false);
                }
                window.tile = kwinTile;
                extensions.lastTiledLocation = GPoint.centerOfRect(
                    kwinTile.absoluteGeometry,
                );
            }
        }

        // bubble up tile size fixing (didn't want to overbloat this function)
        this.fixSizing(realRootTile, rootTile);
    }

    // kwin couldnt do this themselves?
    private fixSizing(rootTile: Tile, kwinRootTile: Kwin.Tile): void {
        // TODO - fixSizing
    }

    addWindow(window: Kwin.Window): void {
        if (this.clients.has(window)) {
            return;
        }
        const client = new Client(window);
        this.clients.set(window, client);

        // tries to use active insertion if it should, but can fail and fall back
        let failedActive: boolean = true;
        activeChecks: if (
            this.engine.config.insertionPoint == InsertionPoint.Active
        ) {
            failedActive = false;
            const activeWindow = this.ctrl.workspace.activeWindow;
            if (activeWindow == null || activeWindow.tile == null) {
                failedActive = true;
                break activeChecks;
            }
            const tile = this.tiles.get(activeWindow.tile);
            if (tile == undefined) {
                failedActive = true;
                break activeChecks;
            }
            this.engine.putClientInTile(client, tile);
        }
        try {
            if (failedActive) {
                this.engine.addClient(client);
            }
            this.engine.buildLayout();
        } catch (e) {
            this.logger.error(e);
        }
    }

    removeWindow(window: Kwin.Window): void {
        const client = this.clients.get(window);
        if (client == undefined) {
            return;
        }
        this.clients.delete(window);
        this.untiledWindows.push(window);
        try {
            this.engine.removeClient(client);
            this.engine.buildLayout();
        } catch (e) {
            this.logger.error(e);
        }
    }

    putWindowInTile(
        window: Kwin.Window,
        kwinTile: Kwin.Tile,
        direction?: Direction,
    ) {
        const tile = this.tiles.get(kwinTile);
        if (tile == undefined) {
            this.logger.error("Tile", kwinTile.absoluteGeometry, "not registered");
            return;
        }
        if (!this.clients.has(window)) {
            this.clients.set(window, new Client(window));
        }
        const client = this.clients.get(window)!;
        try {
            let rotatedDirection = direction;
            if (
                rotatedDirection != null &&
                this.engine.config.rotateLayout &&
                (this.engine.engineCapability &
                    EngineCapability.TranslateRotation) ==
                    EngineCapability.TranslateRotation
            ) {
                rotatedDirection = new DirectionTools(
                    rotatedDirection,
                ).rotateCw();
                this.logger.debug("Insertion direction rotated to", rotatedDirection);
            }
            this.engine.putClientInTile(client, tile, rotatedDirection);
            this.engine.buildLayout();
        } catch (e) {
            this.logger.error(e);
        }
    }

    regenerateLayout(rootTile: Kwin.Tile) {
        const queue: Queue<Kwin.Tile> = new Queue();
        queue.enqueue(rootTile);
        while (queue.size > 0) {
            const kwinTile = queue.dequeue()!;
            const tile = this.tiles.get(kwinTile);
            if (tile == undefined) {
                this.logger.error("Tile", kwinTile.absoluteGeometry, "not registered");
                continue;
            }
            tile.requestedSize = GSize.fromRect(kwinTile.absoluteGeometry);
            // if the layout is mutable (tiles can be created/destroyed) then change it. really only for kwin layout
            if (
                (this.engine.engineCapability &
                    EngineCapability.TilesMutable) ==
                EngineCapability.TilesMutable
            ) {
                // destroy ones that dont exist anymore
                for (const child of tile.tiles) {
                    if (this.tiles.inverse.get(child) == null) {
                        this.tiles.inverse.delete(child);
                        child.remove();
                    }
                }
                // create ones that do (and arent registered)
                for (const child of kwinTile.tiles) {
                    if (!this.tiles.has(child)) {
                        const newTile = tile.addChild();
                        this.tiles.set(child, newTile);
                    }
                }
            }
            for (const child of kwinTile.tiles) {
                queue.enqueue(child);
            }
        }
        try {
            this.engine.regenerateLayout();
            this.engine.buildLayout();
        } catch (e) {
            this.logger.error(e);
        }
    }
}
