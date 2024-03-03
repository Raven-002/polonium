// actions/shortcuts.ts - Shortcuts invoked directly by the user

import { Controller } from "../";
import { Edge, Tile, Window } from "kwin-api";
import { GPoint, GRect } from "../../util/geometry";
import { QPoint } from "kwin-api/qt";
import { Log } from "../../util/log";
import { Config } from "../../util/config";

const enum Direction {
    Above,
    Below,
    Left,
    Right,
}

function pointAbove(window: Window): GPoint | null {
    if (window.tile == null) {
        return null;
    }
    const geometry = window.frameGeometry;
    const coordOffset = 1 + window.tile.padding;
    const x = geometry.x + 1;
    const y = geometry.y - coordOffset;
    return new GPoint({
        x: x,
        y: y,
    });
}

function pointBelow(window: Window): GPoint | null {
    if (window.tile == null) {
        return null;
    }
    const geometry = window.frameGeometry;
    const coordOffset = 1 + geometry.height + window.tile.padding;
    const x = geometry.x + 1;
    const y = geometry.y + coordOffset;
    return new GPoint({
        x: x,
        y: y,
    });
}

function pointLeft(window: Window): GPoint | null {
    if (window.tile == null) {
        return null;
    }
    const geometry = window.frameGeometry;
    let coordOffset = 1 + window.tile.padding;
    let x = geometry.x - coordOffset;
    let y = geometry.y + 1;
    return new GPoint({
        x: x,
        y: y,
    });
}

function pointRight(window: Window): GPoint | null {
    if (window.tile == null) {
        return null;
    }
    const geometry = window.frameGeometry;
    let coordOffset = 1 + geometry.width + window.tile.padding;
    let x = geometry.x + coordOffset;
    let y = geometry.y + 1;
    return new GPoint({
        x: x,
        y: y,
    });
}

function pointInDirection(window: Window, direction: Direction): GPoint | null {
    switch (direction) {
        case Direction.Above:
            return pointAbove(window);
        case Direction.Below:
            return pointBelow(window);
        case Direction.Left:
            return pointLeft(window);
        case Direction.Right:
            return pointRight(window);
        default:
            return null;
    }
}

export class ShortcutManager {
    private ctrl: Controller;
    private logger: Log;
    private config: Config;

    constructor(ctrl: Controller) {
        this.ctrl = ctrl;
        this.logger = ctrl.logger;
        this.config = ctrl.config;
        let shortcuts = ctrl.qmlObjects.shortcuts;
        shortcuts
            .getRetileWindow()
            .activated.connect(this.retileWindow.bind(this));
        shortcuts
            .getOpenSettings()
            .activated.connect(this.openSettingsDialog.bind(this));
        
        shortcuts
            .getFocusAbove()
            .activated.connect(this.focus.bind(this, Direction.Above));
        shortcuts
            .getFocusBelow()
            .activated.connect(this.focus.bind(this, Direction.Below));
        shortcuts
            .getFocusLeft()
            .activated.connect(this.focus.bind(this, Direction.Left));
        shortcuts
            .getFocusRight()
            .activated.connect(this.focus.bind(this, Direction.Right));

        shortcuts
            .getInsertAbove()
            .activated.connect(this.insert.bind(this, Direction.Above));
        shortcuts
            .getInsertBelow()
            .activated.connect(this.insert.bind(this, Direction.Below));
        shortcuts
            .getInsertLeft()
            .activated.connect(this.insert.bind(this, Direction.Left));
        shortcuts
            .getInsertRight()
            .activated.connect(this.insert.bind(this, Direction.Right));

        shortcuts
            .getResizeAbove()
            .activated.connect(this.resize.bind(this, Direction.Above));
        shortcuts
            .getResizeBelow()
            .activated.connect(this.resize.bind(this, Direction.Below));
        shortcuts
            .getResizeLeft()
            .activated.connect(this.resize.bind(this, Direction.Left));
        shortcuts
            .getResizeRight()
            .activated.connect(this.resize.bind(this, Direction.Right));

    }

    retileWindow(): void {
        const window = this.ctrl.workspace.activeWindow;
        if (window == null || !this.ctrl.windowExtensions.has(window)) {
            return;
        }
        if (this.ctrl.windowExtensions.get(window)!.isTiled) {
            this.ctrl.driverManager.removeWindow(window);
        } else {
            this.ctrl.driverManager.addWindow(window);
        }
        this.ctrl.driverManager.rebuildLayout();
    }

    openSettingsDialog(): void {
        const settings = this.ctrl.qmlObjects.settings;
        if (settings.isVisible()) {
            settings.hide();
        } else {
            settings.setSettings(
                this.ctrl.driverManager.getEngineConfig(
                    this.ctrl.desktopFactory.createDefaultDesktop(),
                ),
            );
            settings.show();
        }
    }

    tileInDirection(window: Window, point: QPoint | null): Tile | null {
        if (point == null) {
            return null;
        }
        return this.ctrl.workspace
            .tilingForScreen(window.output)
            .bestTileForPosition(point.x, point.y);
    }

    focus(direction: Direction): void {
        const window = this.ctrl.workspace.activeWindow;
        if (window == null) {
            return;
        }
        const tile = this.tileInDirection(
            window,
            pointInDirection(window, direction),
        );
        if (tile == null || tile.windows.length == 0) {
            return;
        }
        let newWindow = tile.windows[0];
        this.logger.debug("Focusing", newWindow.resourceClass);
        this.ctrl.workspace.activeWindow = newWindow;
    }

    insert(direction: Direction): void {
        const window = this.ctrl.workspace.activeWindow;
        if (window == null) {
            return;
        }
        const point = pointInDirection(window, direction);
        if (point == null) {
            return;
        }
        this.logger.debug("Moving", window.resourceClass);
        this.ctrl.driverManager.removeWindow(window);
        this.ctrl.driverManager.rebuildLayout(window.output);
        let tile = this.tileInDirection(window, point);
        if (tile == null) {
            // usually this works
            tile = this.ctrl.workspace.tilingForScreen(window.output).rootTile;
            while (tile.tiles.length == 1) {
                tile = tile.tiles[0];
            }
        }
        this.ctrl.driverManager.putWindowInTile(
            window,
            tile,
            new GRect(tile.absoluteGeometry).directionFromPoint(point),
        );
        this.ctrl.driverManager.rebuildLayout(window.output);
    }
    
    resize(direction: Direction): void {
        const window = this.ctrl.workspace.activeWindow;
        if (window == null || window.tile == null) {
            return;
        }
        const tile = window.tile;
        const resizeAmount = this.config.resizeAmount;
        // should auto trigger the resize callback
        this.logger.debug("Changing size of", tile.absoluteGeometry);
        switch (direction) {
            case Direction.Above:
                tile.resizeByPixels(resizeAmount, Edge.TopEdge);
                break;
            case Direction.Below:
                tile.resizeByPixels(resizeAmount, Edge.BottomEdge);
                break;
            case Direction.Left:
                tile.resizeByPixels(resizeAmount, Edge.LeftEdge);
                break;
            case Direction.Right:
                tile.resizeByPixels(resizeAmount, Edge.RightEdge);
        }
    }
}