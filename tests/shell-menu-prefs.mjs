import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource')._register();
const root = ARGV[0];
const {default: Preferences} = await import(`file://${root}/prefs.js`);
const [, data] = GLib.file_get_contents(`${root}/metadata.json`);
const metadata = JSON.parse(new TextDecoder().decode(data));
metadata.dir = Gio.File.new_for_path(root);
metadata.path = root;
Adw.init();
const preferences = new Preferences(metadata);
// The real preferences service registers the extension before resolving __().
// Our standalone test imports from the source folder, whose name omits @local.
const {ExtensionPreferences} = await import('resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js');
ExtensionPreferences.lookupByUUID = uuid =>
    [metadata.uuid, GLib.path_get_basename(root)].includes(uuid) ? preferences : null;
ExtensionPreferences.lookupByURL = () => preferences;
const window = new Adw.PreferencesWindow();
preferences.fillPreferencesWindow(window);
const controls = new Map();
function visit(widget) {
    const id = widget.get_buildable_id();
    if (id)
        controls.set(id, widget);
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling())
        visit(child);
}
visit(window);
function assert(value, message) {
    if (!value)
        throw new Error(message);
}
const settings = preferences.getSettings();
const profile = controls.get('shell_menu_style_switch');
const outline = controls.get('dock_outline_switch');
const intensity = controls.get('dock_outline_intensity_scale');
const corners = controls.get('dock_blur_corner_radius_scale');
const brightness = controls.get('dock_blur_brightness_scale');
assert(brightness.get_value() === 85 && brightness.get_adjustment().lower === 10 &&
    brightness.get_adjustment().upper === 100 && brightness.sensitive, 'Blur brightness defaults and range');
brightness.set_value(67);
assert(settings.get_int('dock-blur-brightness') === 67, 'Brightness writes setting');
settings.set_int('dock-blur-brightness', 75);
assert(brightness.get_value() === 75, 'Brightness setting updates slider');
settings.reset('dock-blur-brightness');
assert(brightness.get_value() === 85, 'Brightness reset preserves previous rendering');
const keepRadius = controls.get('shell_menu_keep_dock_radius_switch');
const height = controls.get('dock_height_scale');
const shadow = controls.get('dock_shadow_intensity_scale');
const shadowSize = controls.get('dock_shadow_size_scale');
assert(shadowSize.get_value() === 100 && shadowSize.get_adjustment().lower === 0 &&
    shadowSize.get_adjustment().upper === 200 && shadowSize.sensitive, 'Shadow size defaults and range');
shadowSize.set_value(175);
assert(settings.get_int('dock-shadow-size') === 175, 'Shadow size slider writes setting');
settings.set_int('dock-shadow-size', 25);
assert(shadowSize.get_value() === 25, 'Shadow size setting updates slider');
settings.reset('dock-shadow-size');
assert(shadowSize.get_value() === 100, 'Shadow size reset restores theme dimensions');
const colors = controls.get('shell_menu_colors_switch');
const customColorRow = controls.get('custom_background_color_listboxrow');
const customColorSwitch = controls.get('custom_background_color_switch');
assert(colors.active && colors.sensitive && !customColorRow.sensitive, 'Shell colors enabled by default');
customColorSwitch.active = true;
colors.active = false;
assert(!settings.get_boolean('shell-menu-colors') && customColorRow.sensitive && customColorSwitch.active,
    'Turning off Shell colors restores the saved custom color controls');
settings.set_boolean('shell-menu-colors', true);
assert(colors.active && !customColorRow.sensitive && customColorSwitch.active,
    'Settings update colors toggle without clearing the custom color');
settings.reset('custom-background-color');
assert(!keepRadius.active && keepRadius.sensitive, 'Keep-radius option preserves v1 default');
assert(shadow.get_value() === 100 && shadow.get_adjustment().upper === 200 && shadow.sensitive,
    'Shadow defaults to the Quick Settings intensity');
shadow.set_value(150);
assert(settings.get_int('dock-shadow-intensity') === 150, 'Shadow slider writes setting');
settings.set_int('dock-shadow-intensity', 0);
assert(shadow.get_value() === 0, 'Shadow setting updates slider');
settings.reset('dock-shadow-intensity');
assert(shadow.get_value() === 100, 'Shadow default restores Quick Settings');
assert(height.get_value() === 0 && height.get_adjustment().upper === 12 && height.get_adjustment().lower === -12,
    'Height defaults and range');
assert(height.is_ancestor(controls.get('position_and_size')), 'Height control is in Position and size');
height.set_value(120);
assert(settings.get_int('dock-height') === 12, 'Height slider clamps above +12 px');
settings.set_int('dock-height', -12);
assert(height.get_value() === -12, 'Height setting updates slider');
height.set_value(-120);
assert(settings.get_int('dock-height') === -12, 'Height slider clamps below -12 px');
keepRadius.active = true;
assert(settings.get_boolean('shell-menu-keep-dock-radius'), 'Keep-radius switch binding');
assert(profile.active && !outline.sensitive && !corners.sensitive, 'Profile defaults and sensitivity');
profile.active = false;
assert(colors.sensitive && colors.active, 'Shell colors work independently of outline and shadow');
assert(!settings.get_boolean('shell-menu-style') && outline.sensitive && corners.sensitive,
    'Manual controls after disabling profile');
assert(!keepRadius.sensitive && !shadow.sensitive && !shadowSize.sensitive && keepRadius.active,
    'Dependent controls disabled without losing saved radius option');
outline.active = true;
assert(intensity.sensitive, 'Manual outline intensity enabled');
settings.set_boolean('shell-menu-style', true);
assert(profile.active && !outline.sensitive && !intensity.sensitive && !corners.sensitive,
    'Settings update the switch and disable overridden controls');
assert(keepRadius.sensitive && shadow.sensitive && shadowSize.sensitive, 'Dependent controls reenabled');
const captureDir = GLib.getenv('SOFT_PREFS_CAPTURE_DIR');
if (captureDir) {
    settings.reset('dock-height');
    settings.reset('shell-menu-keep-dock-radius');
    settings.reset('dock-outline');
    const notebook = controls.get('settings_notebook');
    const loop = GLib.MainLoop.new(null, false);
    window.title = 'Dash to Dock Soft';
    window.set_default_size(860, 850);
    window.present();
    let current = '';
    const watcher = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        const command = `${captureDir}/command`;
        if (!Gio.File.new_for_path(command).query_exists(null))
            return GLib.SOURCE_CONTINUE;
        const [, bytes] = GLib.file_get_contents(command);
        const phase = new TextDecoder().decode(bytes);
        if (phase === 'done') {
            loop.quit();
            return GLib.SOURCE_REMOVE;
        }
        if (phase === current)
            return GLib.SOURCE_CONTINUE;
        current = phase;
        notebook.set_current_page(phase === 'position' ? 0 : 3);
        if (phase === 'appearance')
            shadow.grab_focus();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 650, () => {
            const ids = phase === 'position'
                ? ['dock_size_label', 'dock_height_label', 'builtin_theme_label6', 'builtin_theme_label7',
                    'dock_size_scale', 'dock_height_scale', 'icon_size_scale', 'preview_size_scale']
                : ['dock_shadow_intensity_scale', 'dock_shadow_size_scale', 'dock_outline_intensity_scale',
                    'icon_shadow_intensity_scale', 'dock_blur_radius_scale', 'dock_blur_brightness_scale'];
            const bounds = {};
            for (const id of ids) {
                const [ok, rect] = controls.get(id).compute_bounds(window);
                assert(ok, `Allocated control: ${id}`);
                bounds[id] = {x:rect.get_x(), y:rect.get_y(), width:rect.get_width(), height:rect.get_height()};
            }
            GLib.file_set_contents(`${captureDir}/ready`, JSON.stringify({phase, bounds}));
            return GLib.SOURCE_REMOVE;
        });
        return GLib.SOURCE_CONTINUE;
    });
    const timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 20, () => {
        GLib.source_remove(watcher);
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
    loop.run();
    GLib.source_remove(timeout);
}
window.destroy();
print('Preferences: Shell colors, saved custom color, height, radius, shadow and dependent controls passed');
