#!/usr/bin/python3
"""Integration test in a private D-Bus/Wayland session; never changes the desktop.

Run with /usr/bin/python3 tests/shell-menu-headless.py. Requires GNOME Shell 50, PyGObject
and a usable renderer. The temporary helper enables Eval only on the test bus.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
UUID = 'dash-to-dock-shell-soft@local'


def stage():
    with tempfile.TemporaryDirectory(prefix='shell-soft-dock-test-', ignore_cleanup_errors=True) as temporary:
        base = Path(temporary)
        extension = base / 'data/gnome-shell/extensions' / UUID
        shutil.copytree(ROOT, extension, ignore=shutil.ignore_patterns('*.zip', 'validation', 'tests', '.git', '_build'))
        if os.environ.get('SOFT_TEST_NATIVE'):
            backend = extension / 'blurBackend.js'
            backend.write_text(backend.read_text().replace('gi://Blur', 'gi://SoftTestMissingBlur'))
        helper = extension.parent / 'soft-test-helper@local'
        helper.mkdir()
        (helper / 'metadata.json').write_text(json.dumps({
            'uuid': helper.name, 'name': 'Isolated test helper',
            'description': 'Private test session only', 'shell-version': ['50'],
        }))
        (helper / 'extension.js').write_text('''
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
export default class Helper extends Extension {
    enable() { global.context.unsafe_mode = true; }
    disable() { global.context.unsafe_mode = false; }
}
''')
        runtime = base / 'runtime'
        runtime.mkdir(mode=0o700)
        env = dict(os.environ, SOFT_TEST_CHILD='1', XDG_DATA_HOME=str(base / 'data'),
                   XDG_CONFIG_HOME=str(base / 'config'), XDG_CACHE_HOME=str(base / 'cache'),
                   XDG_STATE_HOME=str(base / 'state'), XDG_RUNTIME_DIR=str(runtime))
        env.pop('WAYLAND_DISPLAY', None)
        env.pop('DISPLAY', None)
        try:
            return subprocess.call(['dbus-run-session', '--', '/usr/bin/python3', __file__], env=env)
        finally:
            # GTK can activate the document portal, which creates a FUSE mount
            # in this test's private runtime. Remove only that temporary mount.
            document_mount = runtime / 'doc'
            if os.path.ismount(document_mount):
                subprocess.run(['fusermount3', '-u', str(document_mount)], check=True)
            time.sleep(0.3)


def test():
    import gi
    gi.require_version('Gio', '2.0')
    from gi.repository import Gio, GLib

    shell_settings = Gio.Settings.new('org.gnome.shell')
    shell_settings.set_strv('enabled-extensions', ['soft-test-helper@local', UUID])
    shell_settings.set_boolean('disable-user-extensions', False)
    shell_settings.set_string('welcome-dialog-last-shown-version', '999')
    Gio.Settings.new('org.gnome.desktop.notifications').set_boolean('show-banners', False)
    Gio.Settings.sync()
    output = ROOT / 'validation'
    output.mkdir(exist_ok=True)
    variant = 'shell-menu-native' if os.environ.get('SOFT_TEST_NATIVE') else 'shell-menu'
    log = (output / f'{variant}-session.log').open('w')
    shell = subprocess.Popen(['gnome-shell', '--headless', '--wayland', '--no-x11',
                              '--virtual-monitor=1440x1000'], stdout=log, stderr=log)
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)

    def evaluate(code):
        result = bus.call_sync('org.gnome.Shell', '/org/gnome/Shell', 'org.gnome.Shell',
                               'Eval', GLib.Variant('(s)', (code,)),
                               GLib.VariantType.new('(bs)'), Gio.DBusCallFlags.NONE, 15000, None)
        ok, value = result.unpack()
        if not ok:
            raise RuntimeError(value or 'Eval is not ready')
        return json.loads(value) if value else None

    results = {}

    def check(name, code):
        value = evaluate(code)
        results[name] = value
        if not value:
            raise AssertionError(name)

    try:
        for _ in range(100):
            if shell.poll() is not None:
                raise RuntimeError('Headless Shell exited; see validation/gnome50-session.log')
            try:
                if evaluate('Main.extensionManager.lookup("dash-to-dock-shell-soft@local")?.state === 1'):
                    break
            except Exception:
                pass
            time.sleep(0.2)
        else:
            raise RuntimeError('Extension did not enable; see validation/gnome50-session.log')

        evaluate('(async()=>{globalThis.extension = Main.extensionManager.lookup("dash-to-dock-shell-soft@local").stateObj; '
                 'globalThis.dockModule = await import(extension.dir.get_child("docking.js").get_uri()); '
                 'globalThis.manager = dockModule.DockManager; Main.overview.hide();})()')
        time.sleep(1)
        evaluate('''(() => {
            const St = imports.gi.St;
            globalThis.backdrop = new St.Widget({width:1440, height:1000, reactive:false});
            const colors = ['#9569b8','#328c9c','#bc9451','#496eb0','#8c597a'];
            for (let x=0;x<1440;x+=80)
                backdrop.add_child(new St.Widget({x,y:32,width:80,height:968,
                    style:`background-color: ${colors[(x/80)%colors.length]};`}));
            Main.uiGroup.insert_child_above(backdrop,global.window_group);
            globalThis.dock = manager.allDocks[0];
            globalThis.background = dock.dash._background;
            globalThis.menu = Main.panel.statusArea.quickSettings.menu;
        })()''')
        check('own-identity', 'extension.uuid === "dash-to-dock-shell-soft@local" && '
              'manager.settings.settings_schema.get_id() === "org.gnome.shell.extensions.dash-to-dock-shell-soft"')
        check('profile-default', 'manager.settings.shellMenuStyle && manager.settings.dockBlur && '
              'manager.settings.backgroundOpacity === 0.55')
        evaluate('manager.settings.set_boolean("dock-fixed", true); '
                 'manager.settings.set_boolean("autohide", false); '
                 'manager.settings.set_boolean("intellihide", false);')
        time.sleep(0.5)
        evaluate('globalThis.surfaceValues = actor => { const n=actor.get_theme_node(); '
                 'const c=v=>[v.red,v.green,v.blue,v.alpha]; const s=n.get_box_shadow(); '
                 'return {borders:[0,1,2,3].map(i=>[n.get_border_width(i),c(n.get_border_color(i))]), '
                 'corners:[0,1,2,3].map(i=>n.get_border_radius(i)), '
                 'shadow:s?{x:s.xoffset,y:s.yoffset,blur:s.blur,spread:s.spread,color:c(s.color),inset:s.inset}:null}; };')
        for theme in ['dark','light']:
            evaluate(f'globalThis.interfaceSettings = new Gio.Settings({{schema_id:"org.gnome.desktop.interface"}}); '
                     f'interfaceSettings.set_string("color-scheme","prefer-{theme}");')
            time.sleep(0.7)
            evaluate('globalThis.dock = manager.allDocks[0]; globalThis.background = dock.dash._background; '
                     'globalThis.menu = Main.panel.statusArea.quickSettings.menu; dock._themeManager.updateCustomTheme();')
            time.sleep(0.3)
            results[theme] = evaluate('({dock:surfaceValues(background),menu:surfaceValues(menu.box), '
                                     'fill:background.get_theme_node().get_background_color().alpha})')
            check(f'{theme}-border-shadow-corners-match',
                  'JSON.stringify(surfaceValues(background)) === JSON.stringify(surfaceValues(menu.box))')
            check(f'{theme}-actual-opacity',
                  'Math.abs(background.get_theme_node().get_background_color().alpha - 140) <= 1')
            for position in [0,1,2,3]:
                evaluate(f'manager.settings.set_enum("dock-position",{position});')
                time.sleep(0.4)
                evaluate('globalThis.dock=manager.allDocks[0];globalThis.background=dock.dash._background;')
                check(f'{theme}-position-{position}', 'background.mapped && '
                      'JSON.stringify(surfaceValues(background)) === JSON.stringify(surfaceValues(menu.box))')
            evaluate('manager.settings.set_enum("dock-position",2);')
            time.sleep(0.4)
            evaluate('globalThis.dock=manager.allDocks[0];globalThis.background=dock.dash._background;menu.open();')
            time.sleep(0.4)
            path = json.dumps(str(output / f'shell-menu-{theme}.png'))
            evaluate(f'(async()=>{{const stream=Gio.File.new_for_path({path}).replace(null,false, '
                     'Gio.FileCreateFlags.REPLACE_DESTINATION,null); await new Shell.Screenshot().screenshot(false,stream); '
                     'stream.close(null); return true;})()')
            evaluate('menu.close();')
        evaluate('globalThis.originalMenuStyle=menu.box.get_style(); '
                 'menu.box.set_style("border: 2px solid rgba(180, 90, 30, 0.8); border-radius: 19px; " + '
                 '"box-shadow: 0 3px 8px 1px rgba(10,20,30,0.3);");')
        time.sleep(0.3)
        check('live-menu-style', 'JSON.stringify(surfaceValues(background)) === JSON.stringify(surfaceValues(menu.box))')
        evaluate('globalThis.themeContext=imports.gi.St.ThemeContext.get_for_stage(global.stage); '
                 'globalThis.oldScale=themeContext.scale_factor; themeContext.scale_factor=2;')
        time.sleep(0.5)
        check('scale-2', 'JSON.stringify(surfaceValues(background)) === JSON.stringify(surfaceValues(menu.box))')
        evaluate('themeContext.scale_factor=oldScale;')
        time.sleep(0.5)
        evaluate('menu.box.set_style(originalMenuStyle); manager.settings.set_enum("transparency-mode",3); '
                 'dock._themeManager._transparency._updateSolidStyle();')
        time.sleep(0.3)
        check('dynamic-transparency-keeps-surface',
              'JSON.stringify(surfaceValues(background)) === JSON.stringify(surfaceValues(menu.box))')
        evaluate('manager.settings.set_boolean("shell-menu-style", false);')
        time.sleep(0.3)
        check('profile-off', '!background.get_style().includes("box-shadow")')
        evaluate('manager.settings.set_boolean("shell-menu-style",true);')
        time.sleep(0.5)
        check('profile-on', 'JSON.stringify(surfaceValues(background)) === JSON.stringify(surfaceValues(menu.box))')
        check('full-shadow-unclipped', 'dock._slider.slideX === 1 && !dock._box.has_clip')
        evaluate('dock._slider.slideX=0.4;')
        time.sleep(0.3)
        check('autohide-viewport', 'dock._box.has_clip')
        evaluate('dock._slider.slideX=1;')
        time.sleep(0.3)
        check('shadow-after-show', '!dock._box.has_clip')
        time.sleep(1)
        evaluate('globalThis.frames=0; globalThis.frameId=global.stage.connect("after-paint",()=>frames++);')
        time.sleep(1.5)
        results['idle-frames'] = evaluate('frames')
        evaluate('global.stage.disconnect(frameId);')
        if results['idle-frames'] > 2:
            raise AssertionError('Unexpected idle repaints')
        evaluate('extension.disable();')
        check('disable-cleanup', '!Main.uiGroup.get_children().some(a=>a.name === "dashtodockContainer")')
        evaluate('extension.enable();')
        check('reenable', 'manager.allDocks.length > 0')
        display_env = dict(os.environ, WAYLAND_DISPLAY='wayland-0', GDK_BACKEND='wayland',
                           GSETTINGS_BACKEND='memory',
                           GI_TYPELIB_PATH='/usr/lib64/gnome-shell/girepository-1.0:/usr/lib64/gnome-shell')
        prefs = subprocess.run(['gjs', '-m', str(ROOT / 'tests/shell-menu-prefs.mjs'), str(ROOT)],
                               env=display_env, capture_output=True, text=True, timeout=15)
        results['preferences'] = {'passed': prefs.returncode == 0, 'output': prefs.stdout.strip()}
        if prefs.returncode:
            raise RuntimeError(prefs.stderr)
        results['passed'] = True
        print(json.dumps(results, indent=2))
    finally:
        (output / f'{variant}-results.json').write_text(json.dumps(results, indent=2) + '\n')
        shell.terminate()
        try:
            shell.wait(timeout=10)
        except subprocess.TimeoutExpired:
            shell.kill()
            shell.wait()
        log.close()


if __name__ == '__main__':
    if os.environ.get('SOFT_TEST_CHILD'):
        test()
    else:
        sys.exit(stage())
