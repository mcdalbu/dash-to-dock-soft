// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {
    Clutter,
    Cogl,
    GLib,
    Gio,
    GObject,
    Meta,
    Shell,
    St,
} from './dependencies/gi.js';

import {Main} from './dependencies/shell/ui.js';
import {LoginManager} from './dependencies/shell/misc.js';
import {loadBlurBackend} from './blurBackend.js';
import {BlurRedrawGuard} from './blurRedrawGuard.js';
import {shellMenuSurfaceStyle} from './shellMenuStyle.js';

import {
    Docking,
    Utils,
} from './imports.js';

const {signals: Signals} = imports;
const BlurBackend = await loadBlurBackend(Shell, GObject);
let shadowStyleId = 0;

/*
 * DEFAULT:  transparency given by theme
 * FIXED:    constant transparency chosen by user
 * DYNAMIC:  apply 'transparent' style when no windows are close to the dock
 * */
const TransparencyMode = {
    DEFAULT:  0,
    FIXED:    1,
    DYNAMIC:  3,
};

const Labels = Object.freeze({
    TRANSPARENCY: Symbol('transparency'),
    THEME_CHANGED: Symbol('theme-changed'),
    BLUR_WINDOWS: Symbol('blur-windows'),
    BLUR_DASH: Symbol('blur-dash'),
    BLUR_SESSION: Symbol('blur-session'),
});

export const PositionStyleClass = Object.freeze([
    'top',
    'right',
    'bottom',
    'left',
]);

function getShellMenuBox() {
    return Main.panel?.statusArea?.quickSettings?.menu?.box ??
        Main.panel?.statusArea?.dateMenu?.menu?.box;
}

/**
 * Apply surface options after the upstream theme/transparency styles, including
 * window-driven transparency changes. Keep icon actors and theme radii intact.
 *
 * @param dock
 */
function applyDockSurfaceStyle(dock) {
    const {settings} = Docking.DockManager;
    if (!settings.shellMenuStyle && !settings.dockOutline && !settings.dockBlur)
        return;

    const background = dock.dash._background;
    let style = background.get_style() || '';
    if (style && !style.trimEnd().endsWith(';'))
        style += ';';
    const menu = settings.shellMenuStyle ? getShellMenuBox() : null;
    if (menu) {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        style += shellMenuSurfaceStyle(menu.get_theme_node(), scale,
            settings.shellMenuKeepDockRadius, settings.dockShadowIntensity);
    } else if (settings.dockOutline) {
        const color = background.get_theme_node().get_background_color();
        const luminance = (0.2126 * color.red + 0.7152 * color.green + 0.0722 * color.blue) / 255;
        const alpha = settings.dockOutlineIntensity / 100;
        const borderColor = luminance > 0.5 ? `rgba(0, 0, 0, ${alpha})` : `rgba(255, 255, 255, ${alpha})`;
        style += `border: 1px solid ${borderColor};`;
    }
    if (settings.dockBlur)
        style += 'background-image: none;';
    background.set_style(style);
}

/**
 * Manage theme customization and custom theme support
 */
export class ThemeManager {
    constructor(dock) {
        this._signalsHandler = new Utils.GlobalSignalsHandler(this);
        this._bindSettingsChanges();
        this._actor = dock;
        this._dash = dock.dash;
        this._blurEffect = null;

        // initialize colors with generic values
        this._customizedBackground = {red: 0, green: 0, blue: 0, alpha: 0};
        this._customizedBorder = {red: 0, green: 0, blue: 0, alpha: 0};
        this._transparency = new Transparency(dock);

        this._signalsHandler.add([
            // update :overview pseudoclass
            Main.overview,
            'showing',
            this._onOverviewShowing.bind(this),
        ], [
            Main.overview,
            'hiding',
            this._onOverviewHiding.bind(this),
        ]);

        this._signalsHandler.add(St.ThemeContext.get_for_stage(global.stage),
            'notify::scale-factor', () => this._updateBlur());

        // Opening Quick Settings emits style changes even when its surface is
        // unchanged. Rebuilding the dock theme then would restart transparency
        // transitions. Compare the settled menu surface before applying it.
        const menuBox = getShellMenuBox();
        if (menuBox) {
            this._signalsHandler.add(
                [menuBox, 'style-changed', () => this._queueUpdateShellMenuStyle()],
                [menuBox, 'notify::style', () => this._queueUpdateShellMenuStyle()]);
        }

        this._signalsHandler.addWithLabel(Labels.THEME_CHANGED,
            St.ThemeContext.get_for_stage(global.stage), 'changed',
            () => this._queueUpdateCustomTheme(),
            Utils.SignalsHandlerFlags.CONNECT_AFTER);

        const maybeUpdateCustomTheme = () => {
            if (this._actor.mapped) {
                this._signalsHandler.unblockWithLabel(Labels.THEME_CHANGED);
                this._queueUpdateCustomTheme();
            } else {
                this._dequeueUpdateCustomTheme();
                this._signalsHandler.blockWithLabel(Labels.THEME_CHANGED);
            }
        };

        this._signalsHandler.add(this._actor, 'notify::mapped',
            () => maybeUpdateCustomTheme(),
            Utils.SignalsHandlerFlags.CONNECT_AFTER);

        maybeUpdateCustomTheme();

        // Set the initial overview pseudo-class state.
        if (Main.overview.visible)
            this._onOverviewShowing();
        else
            this._onOverviewHiding();

        this._signalsHandler.add(this._dash._background, 'destroy', () => this._disableBlur());
        for (const actor of [this._dash, this._dash._background])
            this._signalsHandler.add(actor, 'notify::allocation', () => this._queueBlurGeometry());

        // destroy themeManager when the managed actor is destroyed (e.g. extension unload)
        // in order to disconnect signals
        this._signalsHandler.add(this._actor, 'destroy', () => this.destroy());
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._disableIconShadow();
        this._disableBlur();
        this.emit('destroy');
        this._transparency.destroy();
        this._dequeueUpdateCustomTheme();
    }

    _queueUpdateCustomTheme() {
        if (this._updateLater)
            return;

        this._updateLater = Utils.laterAdd(Meta.LaterType.BEFORE_REDRAW, () => {
            this._updateLater = 0;
            this.updateCustomTheme();
        });
    }

    _getShellMenuSignature() {
        const {settings} = Docking.DockManager;
        const menu = settings.shellMenuStyle ? getShellMenuBox() : null;
        if (!menu)
            return null;
        const node = menu.get_theme_node();
        const color = node.get_background_color();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // Dock opacity is independent of the menu opacity. In particular,
        // ignore Gnome Shell Soft briefly restoring its original menu fill.
        const surface = shellMenuSurfaceStyle(node, scale,
            settings.shellMenuKeepDockRadius, settings.dockShadowIntensity);
        return `${color.red},${color.green},${color.blue};${surface}`;
    }

    _queueUpdateShellMenuStyle() {
        if (this._shellMenuLater || !Docking.DockManager.settings.shellMenuStyle)
            return;
        this._shellMenuLater = Utils.laterAdd(Meta.LaterType.BEFORE_REDRAW, () => {
            const signature = this._getShellMenuSignature();
            this._shellMenuLater = 0;
            if (signature !== this._shellMenuSignature)
                this.updateCustomTheme();
        });
    }

    _dequeueUpdateCustomTheme() {
        if (this._shellMenuLater) {
            Utils.laterRemove(this._shellMenuLater);
            this._shellMenuLater = 0;
        }
        if (!this._updateLater)
            return;

        Utils.laterRemove(this._updateLater);
        delete this._updateLater;
    }

    _onOverviewShowing() {
        this._actor.add_style_pseudo_class('overview');
    }

    _onOverviewHiding() {
        this._actor.remove_style_pseudo_class('overview');
    }

    _updateDashOpacity() {
        const newAlpha = Docking.DockManager.settings.backgroundOpacity;

        const [backgroundColor, borderColor] = this._getDefaultColors();

        if (!backgroundColor)
            return;

        // Get the background and border alphas. We check the background alpha
        // for a minimum of .001 to prevent division by 0 errors
        const backgroundAlpha = Math.max(Math.round(backgroundColor.alpha / 2.55) / 100, .001);
        let borderAlpha = Math.round(borderColor.alpha / 2.55) / 100;

        // The border and background alphas should remain in sync
        // We also limit the borderAlpha to a maximum of 1 (full opacity)
        borderAlpha = Math.min((borderAlpha / backgroundAlpha) * newAlpha, 1);

        this._customizedBackground = `rgba(${
            backgroundColor.red},${
            backgroundColor.green},${
            backgroundColor.blue},${
            newAlpha})`;

        this._customizedBorder = `rgba(${
            borderColor.red},${
            borderColor.green},${
            borderColor.blue},${
            borderAlpha})`;
    }

    _getDefaultColors() {
        const menu = Docking.DockManager.settings.shellMenuStyle ? getShellMenuBox() : null;
        if (menu) {
            const node = menu.get_theme_node();
            return [node.get_background_color(), node.get_border_color(St.Side.TOP)];
        }
        // Remove custom style
        const oldStyle = this._dash._background.get_style();
        this._dash._background.set_style(null);

        const themeNode = this._dash._background.get_theme_node();
        this._dash._background.set_style(oldStyle);

        const backgroundColor = themeNode.get_background_color();

        // Just in case the theme has different border colors ..
        // We want to find the inside border-color of the dock because it is
        // the side most visible to the user. We do this by finding the side
        // opposite the position
        const position = Utils.getPosition();
        let side = position + 2;
        if (side > 3)
            side = Math.abs(side - 4);

        const borderColor = themeNode.get_border_color(side);

        return [backgroundColor, borderColor];
    }

    _updateDashColor() {
        // Retrieve the color. If needed we will adjust it before passing it to
        // this._transparency.
        let [backgroundColor] = this._getDefaultColors();

        if (!backgroundColor)
            return;

        const {settings} = Docking.DockManager;

        if (settings.customBackgroundColor) {
            // When applying a custom color, we need to check the alpha value,
            // if not the opacity will always be overridden by the color below.
            // Note that if using 'dynamic' transparency modes,
            // the opacity will be set by the opaque/transparent styles anyway.
            let newAlpha = Math.round(backgroundColor.alpha / 2.55) / 100;

            ({backgroundColor} = settings);
            // backgroundColor is a string like rgb(0,0,0)
            const Color = Clutter.Color ?? Cogl.Color;
            const [ret, color] = Color.from_string(backgroundColor);
            if (!ret) {
                logError(new Error(`${backgroundColor} is not a valid color string`));
                return;
            }

            if (settings.transparencyMode === TransparencyMode.FIXED) {
                newAlpha = settings.backgroundOpacity;
                this._customizedBackground =
                    `rgba(${color.red}, ${color.green}, ${color.blue}, ${newAlpha})`;
            } else {
                this._customizedBackground = backgroundColor;
            }

            this._customizedBorder = this._customizedBackground;

            color.alpha = newAlpha * 255;
            this._transparency.setColor(color);
        } else {
            // backgroundColor is a {Clutter,Cogl}.Color object
            this._transparency.setColor(backgroundColor);
        }
    }

    _repaintBlur() {
        if (!this._blurEffect || !this._blurActor?.mapped)
            return;
        // Damage the complete dock region before Mutter paints it. A cached
        // blur cannot safely reuse a partial window/shadow/hover redraw.
        this._blurActor.queue_redraw();
        this._blurEffect.queue_repaint();
    }

    _queueBlurRepaint() {
        if (!this._blurActor?.mapped || this._blurRepaintLater)
            return;
        this._blurRepaintLater = Utils.laterAdd(Meta.LaterType.BEFORE_REDRAW, () => {
            this._blurRepaintLater = 0;
            this._repaintBlur();
        });
    }

    _refreshBlurForStyle(actor) {
        // Hover/focus styles can animate on a child of the button. Watch the
        // widgets themselves and cover their complete CSS transition, including
        // the final frame, rather than invalidating only on pointer entry.
        const duration = Math.max(0, actor.get_theme_node().get_transition_duration());
        this._blurStyleUntil = Math.max(this._blurStyleUntil || 0,
            GLib.get_monotonic_time() + (duration + 50) * 1000);
        this._queueBlurRepaint();
    }

    _trackBlurDashActor(actor) {
        if (this._blurDashActors.has(actor))
            return;
        const label = Symbol('blur-dash-actor');
        this._blurDashActors.set(actor, label);
        const added = GObject.signal_lookup('child-added', actor) ? 'child-added' : 'actor-added';
        this._signalsHandler.addWithLabel(label,
            [actor, added, (_parent, child) => this._trackBlurDashActor(child)],
            [actor, added === 'child-added' ? 'child-removed' : 'actor-removed',
                (_parent, child) => this._untrackBlurDashActor(child)]);
        if (GObject.signal_lookup('style-changed', actor)) {
            this._signalsHandler.addWithLabel(label,
                [actor, 'style-changed', () => this._refreshBlurForStyle(actor)]);
        }
        for (const child of actor.get_children())
            this._trackBlurDashActor(child);
    }

    _untrackBlurDashActor(actor) {
        const label = this._blurDashActors.get(actor);
        if (!label)
            return;
        for (const child of actor.get_children())
            this._untrackBlurDashActor(child);
        this._signalsHandler.removeWithLabel(label);
        this._blurDashActors.delete(actor);
    }

    _windowIntersectsBlur(actor) {
        if (!actor.mapped || !this._blurActor)
            return false;
        const rect = actor.get_meta_window()?.get_frame_rect();
        if (!rect)
            return false;
        const [x, y] = this._blurActor.get_transformed_position();
        const [width, height] = this._blurActor.get_transformed_size();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const margin = Math.max(64, Docking.DockManager.settings.dockBlurRadius) * scale;
        return rect.x < x + width + margin && rect.x + rect.width > x - margin &&
            rect.y < y + height + margin && rect.y + rect.height > y - margin;
    }

    _trackBlurWindow(actor) {
        if (!actor.get_meta_window || this._blurWindows.has(actor))
            return;
        const label = Symbol('blur-window');
        const record = {label, affected: this._windowIntersectsBlur(actor)};
        this._blurWindows.set(actor, record);
        const update = () => {
            const affected = this._windowIntersectsBlur(actor);
            if (affected || record.affected)
                this._queueBlurRepaint();
            record.affected = affected;
        };
        const signals = ['notify::allocation', 'notify::mapped', 'notify::opacity'];
        if (GObject.signal_lookup('damaged', actor))
            signals.push('damaged');
        this._signalsHandler.addWithLabel(label, ...signals.map(signal => [actor, signal, update]));
        if (record.affected)
            this._queueBlurRepaint();
    }

    _queueBlurRecovery() {
        // Resume can invalidate the backend's framebuffer cache even when the
        // dock allocation and blur parameters have not changed. If the dock is
        // still hidden by the lock screen, recover when it is mapped again.
        this._blurRecoveryPending = true;
        if (this._blurSleeping || Main.sessionMode.isLocked || Main.screenShield?.active ||
            !this._blurActor?.mapped || this._blurRecoveryLater)
            return;
        this._blurRecoveryLater = Utils.laterAdd(Meta.LaterType.BEFORE_REDRAW, () => {
            this._blurRecoveryLater = 0;
            if (this._blurSleeping || Main.sessionMode.isLocked || Main.screenShield?.active ||
                !this._blurActor?.mapped)
                return;
            this._blurRecoveryPending = false;
            this._blurRedrawGuard.end();
            this._blurActor.remove_effect(this._blurEffect);
            this._blurEffect = this._createBlurEffect();
            this._blurActor.add_effect_with_name('soft-dock-blur', this._blurEffect);
            this._updateBlur();
        });
    }

    _startBlurRepaints() {
        this._blurRedrawGuard = new BlurRedrawGuard(Clutter, Meta);
        this._blurDashActors = new Map();
        this._blurStyleUntil = 0;
        this._trackBlurDashActor(this._dash);
        this._signalsHandler.addWithLabel(Labels.BLUR_DASH,
            [global.stage, 'before-update', (_stage, view) => {
                this._blurRedrawGuard.begin(this._blurActor, view);
                if (GLib.get_monotonic_time() < this._blurStyleUntil)
                    this._repaintBlur();
            }],
            // Translations/scaling need not emit notify::allocation. Follow
            // the background after layout on frames already being drawn.
            [global.stage, 'before-paint', () => this._updateBlurGeometry()],
            [global.stage, 'after-update', () => this._blurRedrawGuard.end()]);
        const loginManager = LoginManager.getLoginManager();
        this._blurSleeping = loginManager.preparingForSleep ?? false;
        this._blurRecoveryPending = this._blurSleeping;
        this._signalsHandler.addWithLabel(Labels.BLUR_SESSION,
            [loginManager, 'prepare-for-sleep', (_manager, sleeping) => {
                this._blurSleeping = sleeping;
                this._blurRedrawGuard.end();
                this._queueBlurRecovery();
            }],
            [Main.sessionMode, 'updated', () => {
                if (Main.sessionMode.isLocked) {
                    this._blurRecoveryPending = true;
                    this._blurRedrawGuard.end();
                } else if (this._blurRecoveryPending) {
                    this._queueBlurRecovery();
                }
            }],
            [this._blurActor, 'notify::mapped', () => {
                if (!this._blurActor.mapped) {
                    this._blurRecoveryPending = true;
                    this._blurRedrawGuard.end();
                } else if (this._blurRecoveryPending) {
                    this._queueBlurRecovery();
                } else {
                    this._queueBlurGeometry();
                }
            }]);
        if (Main.screenShield) {
            this._signalsHandler.addWithLabel(Labels.BLUR_SESSION,
                Main.screenShield, 'active-changed', () => {
                    if (this._blurRecoveryPending)
                        this._queueBlurRecovery();
                });
        }
        this._blurWindows = new Map();
        const added = GObject.signal_lookup('child-added', global.window_group)
            ? 'child-added' : 'actor-added';
        const removed = added === 'child-added' ? 'child-removed' : 'actor-removed';
        this._signalsHandler.addWithLabel(Labels.BLUR_WINDOWS,
            [global.window_group, added, (_group, actor) => this._trackBlurWindow(actor)],
            [global.window_group, removed, (_group, actor) => {
                const record = this._blurWindows?.get(actor);
                if (!record)
                    return;
                this._signalsHandler.removeWithLabel(record.label);
                this._blurWindows.delete(actor);
                this._queueBlurRepaint();
            }],
            [global.display, 'restacked', () => this._queueBlurRepaint()]);
        for (const actor of global.get_window_actors())
            this._trackBlurWindow(actor);
    }

    _stopBlurRepaints() {
        this._signalsHandler.removeWithLabel(Labels.BLUR_SESSION);
        if (this._blurRecoveryLater) {
            Utils.laterRemove(this._blurRecoveryLater);
            this._blurRecoveryLater = 0;
        }
        this._blurRecoveryPending = false;
        this._blurSleeping = false;
        this._blurRedrawGuard?.end();
        this._blurRedrawGuard = null;
        if (this._blurDashActors) {
            for (const label of this._blurDashActors.values())
                this._signalsHandler.removeWithLabel(label);
            this._blurDashActors = null;
        }
        this._blurStyleUntil = 0;
        this._signalsHandler.removeWithLabel(Labels.BLUR_DASH);
        if (this._blurRepaintLater) {
            Utils.laterRemove(this._blurRepaintLater);
            this._blurRepaintLater = 0;
        }
        if (!this._blurWindows)
            return;
        for (const {label} of this._blurWindows.values())
            this._signalsHandler.removeWithLabel(label);
        this._signalsHandler.removeWithLabel(Labels.BLUR_WINDOWS);
        this._blurWindows = null;
    }

    _queueBlurGeometry() {
        if (!this._blurGroup || this._blurGeometryLater)
            return;
        this._blurGeometryLater = Utils.laterAdd(Meta.LaterType.BEFORE_REDRAW, () => {
            this._blurGeometryLater = 0;
            this._updateBlurGeometry();
        });
    }

    _updateBlurGeometry() {
        if (!this._blurActor || !this._dash._background.mapped)
            return;
        const background = this._dash._background;
        const [stageX, stageY] = background.get_transformed_position();
        const [stageWidth, stageHeight] = background.get_transformed_size();
        // The group deliberately has zero size to stay out of the box layout;
        // inverse stage transforms require the allocated, nonempty parent.
        const parent = this._blurGroup.get_parent();
        const [validStart, parentX, parentY] = parent.transform_stage_point(stageX, stageY);
        const [validEnd, right, bottom] = parent.transform_stage_point(
            stageX + stageWidth, stageY + stageHeight);
        if (!validStart || !validEnd)
            return;
        const x = parentX - this._blurGroup.x;
        const y = parentY - this._blurGroup.y;
        const width = right - parentX;
        const height = bottom - parentY;
        if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0)
            return;
        const actor = this._blurActor;
        if (Math.abs(actor.x - x) < 0.01 && Math.abs(actor.y - y) < 0.01 &&
            Math.abs(actor.width - width) < 0.01 && Math.abs(actor.height - height) < 0.01)
            return;
        actor.set_position(x, y);
        actor.set_size(width, height);
        this._queueBlurRepaint();
    }

    _disableBlur() {
        this._stopBlurRepaints();
        if (this._blurGeometryLater) {
            Utils.laterRemove(this._blurGeometryLater);
            this._blurGeometryLater = 0;
        }
        this._blurGroup?.destroy();
        this._blurGroup = null;
        this._blurActor = null;
        this._blurEffect = null;
    }

    _createBlurEffect() {
        const properties = BlurBackend.BlurEffect.list_properties().map(property => property.name);
        this._blurRadiusProperty = properties.includes('radius') ? 'radius' : 'sigma';
        this._blurHasCornerRadius = properties.includes('corner-radius');
        return new BlurBackend.BlurEffect({
            mode: BlurBackend.BlurMode.BACKGROUND,
            brightness: 0.85,
        });
    }

    _updateBlur() {
        const {settings} = Docking.DockManager;
        if (!settings.dockBlur) {
            this._disableBlur();
            return;
        }

        if (!this._blurEffect) {
            const parent = this._dash.get_parent();
            if (!parent)
                return;
            this._blurEffect = this._createBlurEffect();
            // The dash uses offscreen rendering. Sample the stage backdrop
            // outside that subtree, underneath both the tint and the icons.
            this._blurGroup = new Meta.BackgroundGroup({
                name: 'soft-dock-blur-group', width: 0, height: 0,
            });
            this._blurActor = new St.Widget({
                name: 'soft-dock-blur-background', reactive: false,
                style: 'background-color: transparent;',
            });
            this._blurActor.add_effect_with_name('soft-dock-blur', this._blurEffect);
            this._blurGroup.add_child(this._blurActor);
            parent.insert_child_below(this._blurGroup, this._dash);
            this._startBlurRepaints();
        }

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const radius = settings.dockBlurRadius * scale;
        this._blurEffect[this._blurRadiusProperty] =
            this._blurRadiusProperty === 'radius' ? radius : radius / 2;
        if (this._blurHasCornerRadius) {
            this._blurEffect.corner_radius = settings.shellMenuStyle && getShellMenuBox()
                ? this._dash._background.get_theme_node().get_border_radius(St.Corner.TOPLEFT)
                : settings.dockBlurCornerRadius * scale;
        }
        this._updateBlurGeometry();
        this._queueBlurGeometry();
        this._queueBlurRepaint();
    }

    _disableIconShadow() {
        if (this._shadowFile) {
            this._unloadShadowStylesheet();
            this._shadowFile.delete(null);
        }
        this._shadowFile = null;
        this._shadowTheme = null;
        this._shadowCss = null;
        if (this._shadowClass)
            this._actor.remove_style_class_name(this._shadowClass);
    }

    _unloadShadowStylesheet() {
        // Shell copies custom stylesheets to the replacement theme. The old
        // theme stored here can differ from the current theme during teardown
        // on unlock. Remove both references before deleting the temporary file.
        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        for (const owner of new Set([this._shadowTheme, theme]))
            owner?.unload_stylesheet(this._shadowFile);
    }

    _updateIconShadow() {
        const {settings} = Docking.DockManager;
        if (!settings.iconShadow) {
            this._disableIconShadow();
            return;
        }

        // A scoped stylesheet also covers icons created/replaced after startup,
        // without overwriting their inline styles or generating every possible
        // combination of the four shadow controls in the bundled stylesheet.
        this._shadowClass ??= `soft-shadow-profile-${++shadowStyleId}`;
        const css = `#dashtodockContainer.soft-icon-shadow.${this._shadowClass} .overview-icon StIcon {` +
            `icon-shadow: ${settings.iconShadowOffsetX}px ${settings.iconShadowOffsetY}px ` +
            `${settings.iconShadowBlur}px rgba(0, 0, 0, ${settings.iconShadowIntensity / 100});}`;
        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        if (this._shadowTheme === theme && this._shadowCss === css)
            return;

        if (!this._shadowFile) {
            const [file, stream] = Gio.File.new_tmp('dash-to-dock-shell-soft-shadow-XXXXXX');
            stream.close(null);
            this._shadowFile = file;
        } else {
            this._unloadShadowStylesheet();
        }
        this._shadowFile.replace_contents(css, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        // Cache before loading: load_stylesheet emits ThemeContext::changed.
        this._shadowCss = css;
        this._shadowTheme = theme;
        this._actor.add_style_class_name(this._shadowClass);
        theme.load_stylesheet(this._shadowFile);
    }

    _updateCustomStyleClasses() {
        if (Docking.DockManager.settings.shellMenuStyle)
            this._actor.add_style_class_name('shell-menu-style');
        else
            this._actor.remove_style_class_name('shell-menu-style');
        const {settings} = Docking.DockManager;

        if (settings.applyCustomTheme)
            this._actor.add_style_class_name('dashtodock');
        else
            this._actor.remove_style_class_name('dashtodock');

        if (settings.iconShadow)
            this._actor.add_style_class_name('soft-icon-shadow');
        else
            this._actor.remove_style_class_name('soft-icon-shadow');

        this._updateIconShadow();

        if (settings.customThemeShrink)
            this._actor.add_style_class_name('shrink');
        else
            this._actor.remove_style_class_name('shrink');

        if (settings.runningIndicatorStyle !== 0)
            this._actor.add_style_class_name('running-dots');
        else
            this._actor.remove_style_class_name('running-dots');

        // If not the built-in theme option is not selected
        if (!settings.applyCustomTheme) {
            if (settings.forceStraightCorner)
                this._actor.add_style_class_name('straight-corner');
            else
                this._actor.remove_style_class_name('straight-corner');
        } else {
            this._actor.remove_style_class_name('straight-corner');
        }
    }

    updateCustomTheme() {
        if (!this._actor.mapped)
            return;

        this._updateCustomStyleClasses();
        this._updateDashOpacity();
        this._updateDashColor();
        this._adjustTheme();
        applyDockSurfaceStyle(this._actor);
        this._updateBlur();
        this._shellMenuSignature = this._getShellMenuSignature();
        this.emit('updated');
    }

    /**
     * Reimported back and adapted from atomdock
     */
    _adjustTheme() {
        const {settings} = Docking.DockManager;

        // Remove prior style edits
        this._dash._background.set_style(null);
        this._transparency.disable();

        // If built-in theme is enabled do nothing else
        if (settings.applyCustomTheme)
            return;

        let newStyle = '';
        const position = Utils.getPosition(settings);

        // obtain theme border settings
        const themeNode = this._dash._background.get_theme_node();
        const borderColor = themeNode.get_border_color(St.Side.TOP);
        const borderWidth = themeNode.get_border_width(St.Side.TOP);

        // We're copying border and corner styles to left border and top-left
        // corner, also removing bottom border and bottom-right corner styles
        let borderMissingStyle = '';

        if (this._rtl && (position !== St.Side.RIGHT)) {
            borderMissingStyle = `border-right: ${borderWidth}px solid ${
                borderColor.to_string()};`;
        } else if (!this._rtl && (position !== St.Side.LEFT)) {
            borderMissingStyle = `border-left: ${borderWidth}px solid ${
                borderColor.to_string()};`;
        }

        newStyle = borderMissingStyle;

        if (newStyle) {
            // I do call set_style possibly twice so that only the background gets the transition.
            // The transition-property css rules seems to be unsupported
            this._dash._background.set_style(newStyle);
        }

        // Customize background
        const fixedTransparency = settings.transparencyMode === TransparencyMode.FIXED;
        const defaultTransparency = settings.transparencyMode === TransparencyMode.DEFAULT;
        if (!defaultTransparency && !fixedTransparency) {
            this._transparency.enable();
        } else if (!defaultTransparency || settings.customBackgroundColor) {
            newStyle = `${newStyle}background-color:${this._customizedBackground}; ` +
                       `border-color:${this._customizedBorder}; ` +
                       'transition-delay: 0s; transition-duration: 0.250s;';
            this._dash._background.set_style(newStyle);
        }
    }

    _bindSettingsChanges() {
        const keys = ['transparency-mode',
            'shell-menu-style',
            'shell-menu-keep-dock-radius',
            'dock-shadow-intensity',
            'customize-alphas',
            'min-alpha',
            'max-alpha',
            'background-opacity',
            'custom-background-color',
            'background-color',
            'apply-custom-theme',
            'custom-theme-shrink',
            'icon-shadow',
            'icon-shadow-intensity',
            'icon-shadow-offset-x',
            'icon-shadow-offset-y',
            'icon-shadow-blur',
            'dock-outline',
            'dock-outline-intensity',
            'dock-blur',
            'dock-blur-radius',
            'dock-blur-corner-radius',
            'custom-theme-running-dots',
            'extend-height',
            'force-straight-corner'];

        this._signalsHandler.addWithLabel(Labels.THEME_CHANGED, ...keys.map(key => [
            Docking.DockManager.settings,
            `changed::${key}`,
            () => this.updateCustomTheme(),
        ]));
    }
}
Signals.addSignalMethods(ThemeManager.prototype);

/**
 * The following class is based on the following upstream commit:
 * https://git.gnome.org/browse/gnome-shell/commit/?id=447bf55e45b00426ed908b1b1035f472c2466956
 * Transparency when free-floating
 */
class Transparency {
    constructor(dock) {
        this._dash = dock.dash;
        this._actor = this._dash._container;
        this._backgroundActor = this._dash._background;
        this._dockActor = dock;
        this._dock = dock;
        this._panel = Main.panel;
        this._position = Utils.getPosition();

        // All these properties are replaced with the ones in the .dummy-opaque
        // and .dummy-transparent css classes
        this._backgroundColor = '0,0,0';
        this._transparentAlpha = '0.2';
        this._opaqueAlpha = '1';
        this._transparentAlphaBorder = '0.1';
        this._opaqueAlphaBorder = '0.5';
        this._transparentTransition = '0ms';
        this._opaqueTransition = '0ms';
        this._base_actor_style = '';

        this._signalsHandler = new Utils.GlobalSignalsHandler();
        this._trackedWindows = new Map();
    }

    enable() {
        // ensure I never double-register/inject
        // although it should never happen
        this.disable();

        this._base_actor_style = this._actor.get_style();
        if (!this._base_actor_style)
            this._base_actor_style = '';


        let addedSignal = 'child-added';
        let removedSignal = 'child-removed';

        // for compatibility with Gnome Shell 45
        if (GObject.signal_lookup('actor-added', global.window_group)) {
            addedSignal = 'actor-added';
            removedSignal = 'actor-removed';
        }

        this._signalsHandler.addWithLabel(Labels.TRANSPARENCY, [
            global.window_group,
            addedSignal,
            this._onWindowActorAdded.bind(this),
        ], [
            global.window_group,
            removedSignal,
            this._onWindowActorRemoved.bind(this),
        ], [
            global.window_manager,
            'switch-workspace',
            this._updateSolidStyle.bind(this),
        ], [
            Main.overview,
            'hiding',
            this._updateSolidStyle.bind(this),
        ], [
            Main.overview,
            'showing',
            this._updateSolidStyle.bind(this),
        ]);

        // Window signals
        global.window_group.get_children().filter(child => {
            // An irrelevant window actor ('Gnome-shell') produces an error when the signals are
            // disconnected, therefore do not add signals to it.
            return child instanceof Meta.WindowActor &&
                   child.get_meta_window().get_wm_class() !== 'Gnome-shell';
        }).forEach(function (win) {
            this._onWindowActorAdded(null, win);
        }, this);

        if (this._actor.get_stage())
            this._updateSolidStyle();

        this._updateStyles();
        this._updateSolidStyle();

        this.emit('transparency-enabled');
    }

    disable() {
        // ensure I never double-register/inject
        // although it should never happen
        this._signalsHandler.removeWithLabel(Labels.TRANSPARENCY);

        for (const key of this._trackedWindows.keys()) {
            this._trackedWindows.get(key).forEach(id => {
                key.disconnect(id);
            });
        }
        this._trackedWindows.clear();

        this.emit('transparency-disabled');
    }

    destroy() {
        this.disable();
        this._signalsHandler.destroy();
    }

    _onWindowActorAdded(container, metaWindowActor) {
        const signalIds = [];
        ['notify::allocation', 'notify::visible'].forEach(s => {
            signalIds.push(metaWindowActor.connect(s, this._updateSolidStyle.bind(this)));
        });
        this._trackedWindows.set(metaWindowActor, signalIds);
    }

    _onWindowActorRemoved(container, metaWindowActor) {
        if (!this._trackedWindows.get(metaWindowActor))
            return;

        this._trackedWindows.get(metaWindowActor).forEach(id => {
            metaWindowActor.disconnect(id);
        });
        this._trackedWindows.delete(metaWindowActor);
        this._updateSolidStyle();
    }

    _updateSolidStyle() {
        const isNear = this._dockIsNear();
        if (isNear) {
            this._backgroundActor.set_style(this._opaque_style);
            this._dockActor.remove_style_class_name('transparent');
            this._dockActor.add_style_class_name('opaque');
        } else {
            this._backgroundActor.set_style(this._transparent_style);
            this._dockActor.remove_style_class_name('opaque');
            this._dockActor.add_style_class_name('transparent');
        }

        applyDockSurfaceStyle(this._dock);
        this.emit('solid-style-updated', isNear);
    }

    _dockIsNear() {
        if (this._dockActor.has_style_pseudo_class('overview'))
            return false;
        /* Get all the windows in the active workspace that are in the primary monitor and visible */
        const activeWorkspace = global.workspace_manager.get_active_workspace();
        const dash = this._dash;
        const windows = activeWorkspace.list_windows().filter(metaWindow => {
            return metaWindow.get_monitor() === dash._monitorIndex &&
                   metaWindow.showing_on_its_workspace() &&
                   metaWindow.get_window_type() !== Meta.WindowType.DESKTOP &&
                   !metaWindow.skip_taskbar;
        });

        /* Check if at least one window is near enough to the panel.
         * If the dock is hidden, we need to account for the space it would take
         * up when it slides out. This is avoid an ugly transition.
         * */
        let factor = 0;
        if (!Docking.DockManager.settings.dockFixed &&
            this._dock.dockState === Docking.State.HIDDEN)
            factor = 1;
        const [leftCoord, topCoord] = this._actor.get_transformed_position();
        let threshold;
        if (this._position === St.Side.LEFT)
            threshold = leftCoord + this._actor.get_width() * (factor + 1);
        else if (this._position === St.Side.RIGHT)
            threshold = leftCoord - this._actor.get_width() * factor;
        else if (this._position === St.Side.TOP)
            threshold = topCoord + this._actor.get_height() * (factor + 1);
        else
            threshold = topCoord - this._actor.get_height() * factor;

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const isNearEnough = windows.some(metaWindow => {
            let coord;
            if (this._position === St.Side.LEFT) {
                coord = metaWindow.get_frame_rect().x;
                return coord < threshold + 5 * scale;
            } else if (this._position === St.Side.RIGHT) {
                coord = metaWindow.get_frame_rect().x + metaWindow.get_frame_rect().width;
                return coord > threshold - 5 * scale;
            } else if (this._position === St.Side.TOP) {
                coord = metaWindow.get_frame_rect().y;
                return coord < threshold + 5 * scale;
            } else {
                coord = metaWindow.get_frame_rect().y + metaWindow.get_frame_rect().height;
                return coord > threshold - 5 * scale;
            }
        });

        return isNearEnough;
    }

    _updateStyles() {
        this._getAlphas();

        this._transparent_style = `${this._base_actor_style
        }background-color: rgba(${
            this._backgroundColor}, ${this._transparentAlpha});` +
            `border-color: rgba(${
                this._backgroundColor}, ${this._transparentAlphaBorder});` +
            `transition-duration: ${this._transparentTransition}ms;`;

        this._opaque_style = `${this._base_actor_style
        }background-color: rgba(${
            this._backgroundColor}, ${this._opaqueAlpha});` +
            `border-color: rgba(${
                this._backgroundColor},${this._opaqueAlphaBorder});` +
            `transition-duration: ${this._opaqueTransition}ms;`;

        this.emit('styles-updated');
    }

    setColor(color) {
        this._backgroundColor = `${color.red},${color.green},${color.blue}`;
        this._updateStyles();
    }

    _getAlphas() {
        // Create dummy object and add to the uiGroup to get it to the stage
        const dummyObject = new St.Bin({
            name: 'dashtodockContainer',
        });
        Main.uiGroup.add_child(dummyObject);

        dummyObject.add_style_class_name('dummy-opaque');
        let themeNode = dummyObject.get_theme_node();
        this._opaqueAlpha = themeNode.get_background_color().alpha / 255;
        this._opaqueAlphaBorder = themeNode.get_border_color(0).alpha / 255;
        this._opaqueTransition = themeNode.get_transition_duration();

        dummyObject.add_style_class_name('dummy-transparent');
        themeNode = dummyObject.get_theme_node();
        this._transparentAlpha = themeNode.get_background_color().alpha / 255;
        this._transparentAlphaBorder = themeNode.get_border_color(0).alpha / 255;
        this._transparentTransition = themeNode.get_transition_duration();

        Main.uiGroup.remove_child(dummyObject);

        const {settings} = Docking.DockManager;

        if (settings.customizeAlphas) {
            this._opaqueAlpha = settings.maxAlpha;
            this._opaqueAlphaBorder = this._opaqueAlpha / 2;
            this._transparentAlpha = settings.minAlpha;
            this._transparentAlphaBorder = this._transparentAlpha / 2;
        }
    }
}
Signals.addSignalMethods(Transparency.prototype);
