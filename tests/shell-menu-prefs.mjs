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
assert(profile.active && !outline.sensitive && !corners.sensitive, 'Profile defaults and sensitivity');
profile.active = false;
assert(!settings.get_boolean('shell-menu-style') && outline.sensitive && corners.sensitive,
    'Manual controls after disabling profile');
outline.active = true;
assert(intensity.sensitive, 'Manual outline intensity enabled');
settings.set_boolean('shell-menu-style', true);
assert(profile.active && !outline.sensitive && !intensity.sensitive && !corners.sensitive,
    'Settings update the switch and disable overridden controls');
window.destroy();
print('Preferences: profile binding, defaults and dependent controls passed');
