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
UUID = 'dash-to-dock-soft@local'


def stage():
    with tempfile.TemporaryDirectory(prefix='shell-soft-dock-test-', ignore_cleanup_errors=True) as temporary:
        base = Path(temporary)
        extension = base / 'data/gnome-shell/extensions' / UUID
        shutil.copytree(ROOT, extension, ignore=shutil.ignore_patterns(
            '*.zip', 'validation', 'tests', '.git', '_build', 'dash-to-dock-soft@local_v*'))
        locale = extension / 'locale/pt_BR/LC_MESSAGES'
        locale.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / 'po/pt_BR.mo', locale / 'dashtodock.mo')
        if os.environ.get('SOFT_TEST_WITH_SHELL_SOFT'):
            shutil.copytree(ROOT.parent / 'gnome-shell-soft', extension.parent / 'gnome-shell-soft@local',
                            ignore=shutil.ignore_patterns('*.zip', '.git', 'validation', 'tests', '*@local_v*'))
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
                unmount = subprocess.run(['fusermount3', '-u', str(document_mount)], capture_output=True)
                # The portal may unmount itself between ismount() and fusermount.
                if unmount.returncode and os.path.ismount(document_mount):
                    unmount.check_returncode()
            time.sleep(0.3)


def test():
    import gi
    gi.require_version('Gio', '2.0')
    gi.require_version('GdkPixbuf', '2.0')
    from gi.repository import Gio, GLib, GdkPixbuf

    shell_settings = Gio.Settings.new('org.gnome.shell')
    enabled = ['soft-test-helper@local']
    if os.environ.get('SOFT_TEST_WITH_SHELL_SOFT'):
        enabled.append('gnome-shell-soft@local')
    shell_settings.set_strv('enabled-extensions', enabled + [UUID])
    shell_settings.set_boolean('disable-user-extensions', False)
    shell_settings.set_string('welcome-dialog-last-shown-version', '999')
    Gio.Settings.new('org.gnome.desktop.notifications').set_boolean('show-banners', False)
    Gio.Settings.sync()
    output = ROOT / 'validation'
    output.mkdir(exist_ok=True)
    variant = 'shell-menu-native' if os.environ.get('SOFT_TEST_NATIVE') else 'shell-menu'
    if os.environ.get('SOFT_TEST_WITH_SHELL_SOFT'):
        variant += '-integrated'
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

    def screenshot(path):
        evaluate('globalThis.captureDone=false; '
                 f'(async()=>{{const stream=Gio.File.new_for_path({json.dumps(str(path))}).replace(null,false, '
                 'Gio.FileCreateFlags.REPLACE_DESTINATION,null);await new Shell.Screenshot().screenshot(false,stream);'
                 'stream.close(null);globalThis.captureDone=true;})()')
        deadline = time.monotonic() + 5
        while not evaluate('captureDone'):
            if time.monotonic() > deadline:
                raise RuntimeError('Shadow screenshot timed out')
            time.sleep(0.03)

    def exterior_difference(on, off, box):
        images = [GdkPixbuf.Pixbuf.new_from_file(str(path)) for path in [on, off]]
        a, b = images
        assert a.get_width() == b.get_width() and a.get_height() == b.get_height()
        assert a.get_n_channels() == b.get_n_channels()
        pixels = [image.get_pixels() for image in images]
        left, top, width, height = box
        count, maximum = 0, 0
        for y in range(max(32, int(top)-24), min(a.get_height(), int(top+height)+24)):
            for x in range(max(0, int(left)-24), min(a.get_width(), int(left+width)+24)):
                if left <= x < left+width and top <= y < top+height:
                    continue
                indices = [y*image.get_rowstride()+x*image.get_n_channels() for image in images]
                difference = max(abs(pixels[0][indices[0]+c]-pixels[1][indices[1]+c]) for c in range(3))
                maximum = max(maximum, difference)
                count += difference >= 3
        return {'pixels': count, 'maximum': maximum}

    try:
        for _ in range(100):
            if shell.poll() is not None:
                raise RuntimeError('Headless Shell exited; see validation/gnome50-session.log')
            try:
                if evaluate('Main.extensionManager.lookup("dash-to-dock-soft@local")?.state === 1'):
                    break
            except Exception:
                pass
            time.sleep(0.2)
        else:
            raise RuntimeError('Extension did not enable; see validation/gnome50-session.log')

        evaluate('(async()=>{globalThis.extension = Main.extensionManager.lookup("dash-to-dock-soft@local").stateObj; '
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
        check('own-identity', 'extension.uuid === "dash-to-dock-soft@local" && '
              'manager.settings.settings_schema.get_id() === "org.gnome.shell.extensions.dash-to-dock-soft"')
        check('profile-default', 'manager.settings.shellMenuStyle && manager.settings.dockBlur && '
              'manager.settings.backgroundOpacity === 0.55 && manager.settings.dockShadowIntensity === 100')
        evaluate('manager.settings.set_boolean("dock-fixed", true); '
                 'manager.settings.set_boolean("autohide", false); '
                 'manager.settings.set_boolean("intellihide", false);')
        time.sleep(0.5)
        evaluate('globalThis.surfaceValues = actor => { const n=actor.get_theme_node(); '
                 'const c=v=>[v.red,v.green,v.blue,v.alpha]; const s=n.get_box_shadow(); '
                 'return {borders:[0,1,2,3].map(i=>[n.get_border_width(i),c(n.get_border_color(i))]), '
                 'corners:[0,1,2,3].map(i=>n.get_border_radius(i)), '
                 'shadow:s?{x:s.xoffset,y:s.yoffset,blur:s.blur,spread:s.spread,color:c(s.color),inset:s.inset}:null}; };')
        evaluate('globalThis.fillValues=actor=>{const c=actor.get_theme_node().get_background_color(); '
                 'return [c.red,c.green,c.blue,c.alpha];};')
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
            check(f'{theme}-shell-menu-colors',
                  'JSON.stringify(fillValues(background).slice(0,3)) === JSON.stringify(fillValues(menu.box).slice(0,3))')
            time.sleep(0.6)
            evaluate('globalThis.menuTrace={styles:0,updates:0,alphas:[]}; '
                     'globalThis.styleTraceId=background.connect("notify::style",()=>menuTrace.styles++); '
                     'globalThis.updateTraceId=dock._themeManager.connect("updated",()=>menuTrace.updates++); '
                     'globalThis.paintTraceId=global.stage.connect("before-paint",()=> '
                     'menuTrace.alphas.push(background.get_theme_node().get_background_color().alpha));')
            for _ in range(3):
                evaluate('menu.open();')
                time.sleep(0.4)
                evaluate('menu.close();')
                time.sleep(0.3)
            results[f'{theme}-quick-settings-trace'] = evaluate('menuTrace')
            evaluate('background.disconnect(styleTraceId);dock._themeManager.disconnect(updateTraceId); '
                     'global.stage.disconnect(paintTraceId);')
            trace = results[f'{theme}-quick-settings-trace']
            assert trace['styles'] == 0 and trace['updates'] == 0, 'Quick Settings reapplies the dock theme'
            assert trace['alphas'] and all(abs(alpha-140)<=1 for alpha in trace['alphas']), 'Opacity flash'
            for intensity in [0, 50, 100, 150, 200]:
                evaluate(f'manager.settings.set_int("dock-shadow-intensity",{intensity});')
                time.sleep(0.2)
                check(f'{theme}-shadow-{intensity}', '''(() => {
                    const a=surfaceValues(background), b=surfaceValues(menu.box);
                    const expected=Math.min(255,b.shadow.color[3]*manager.settings.dockShadowIntensity/100);
                    const alpha=a.shadow?.color[3] ?? 0;
                    if (a.shadow) a.shadow.color[3]=b.shadow.color[3];
                    return Math.abs(alpha-expected)<=1 && (expected===0 || JSON.stringify(a)===JSON.stringify(b)) &&
                        JSON.stringify(a.borders)===JSON.stringify(b.borders) &&
                        JSON.stringify(a.corners)===JSON.stringify(b.corners);
                })()''')
            evaluate('manager.settings.set_int("dock-shadow-intensity",100);')
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
        evaluate('globalThis.colorTestStyle=menu.box.get_style(); '
                 'menu.box.set_style("background-color: rgb(32,84,128);"); '
                 'manager.settings.set_string("background-color","rgb(197,43,71)"); '
                 'manager.settings.set_boolean("custom-background-color",true);')
        time.sleep(0.4)
        check('shell-colors-override-saved-custom-color',
              'JSON.stringify(fillValues(background)) === "[32,84,128,140]"')
        evaluate('manager.settings.set_boolean("shell-menu-colors",false);')
        time.sleep(0.4)
        check('colors-off-restores-custom-color',
              'JSON.stringify(fillValues(background)) === "[197,43,71,140]" && '
              'JSON.stringify(surfaceValues(background)) === JSON.stringify(surfaceValues(menu.box))')
        evaluate('manager.settings.set_boolean("shell-menu-style",false); '
                 'manager.settings.set_boolean("shell-menu-colors",true);')
        time.sleep(0.4)
        check('shell-colors-independent-of-outline',
              'JSON.stringify(fillValues(background)) === "[32,84,128,140]" && '
              '!background.get_style().includes("box-shadow")')
        evaluate('menu.box.set_style("background-color: rgb(61,102,43);");')
        time.sleep(0.4)
        check('colors-only-follows-live-menu-color', 'JSON.stringify(fillValues(background)) === "[61,102,43,140]"')
        for mode in [0,3]:
            evaluate(f'manager.settings.set_enum("transparency-mode",{mode});')
            time.sleep(0.4)
            check(f'shell-colors-opacity-mode-{mode}',
                  'JSON.stringify(fillValues(background).slice(0,3)) === "[61,102,43]"')
        evaluate('manager.settings.set_boolean("apply-custom-theme",true);')
        time.sleep(0.4)
        check('shell-colors-built-in-theme',
              'JSON.stringify(fillValues(background).slice(0,3)) === "[61,102,43]"')
        evaluate('manager.settings.set_boolean("apply-custom-theme",false); '
                 'manager.settings.set_boolean("shell-menu-style",true); '
                 'manager.settings.set_enum("transparency-mode",1); '
                 'manager.settings.reset("custom-background-color");manager.settings.reset("background-color"); '
                 'menu.box.set_style(colorTestStyle);')
        time.sleep(0.4)
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
        evaluate('manager.settings.set_boolean("shell-menu-style",false);')
        time.sleep(0.3)
        evaluate('globalThis.nativeCorners=surfaceValues(background).corners; '
                 'manager.settings.set_boolean("shell-menu-keep-dock-radius",true); '
                 'manager.settings.set_boolean("shell-menu-style",true);')
        time.sleep(0.3)
        check('keep-native-corners', 'JSON.stringify(surfaceValues(background).corners) === JSON.stringify(nativeCorners)')
        check('native-corners-keep-shadow', '(() => {const a=surfaceValues(background);const b=surfaceValues(menu.box); '
              'a.corners=b.corners;return JSON.stringify(a)===JSON.stringify(b);})()')
        check('blur-native-corners', '!dock._themeManager._blurHasCornerRadius || '
              'dock._themeManager._blurEffect.corner_radius === nativeCorners[0]')
        evaluate('manager.settings.set_boolean("custom-theme-shrink",true);')
        time.sleep(0.3)
        check('compact-native-corners', 'background.get_theme_node().get_border_radius(0) < nativeCorners[0]')
        evaluate('manager.settings.set_boolean("custom-theme-shrink",false);')
        time.sleep(0.3)
        evaluate('manager.settings.set_boolean("extend-height",true);')
        time.sleep(0.3)
        check('panel-native-corners', 'surfaceValues(background).corners.every(v=>v===0)')
        evaluate('manager.settings.set_boolean("extend-height",false);')
        time.sleep(0.3)
        evaluate('manager.settings.set_int("dock-height",0);')
        time.sleep(0.3)
        baseline = evaluate('({y:background.get_transformed_position()[1],height:background.height, '
                            'width:background.width,iconSize:dock.dash.iconSize})')
        results['vertical-position'] = []
        for offset in [32, 120, 256, 80, 0, -8, -32, -64, -120, -256, 0]:
            evaluate(f'manager.settings.set_int("dock-height",{offset});')
            time.sleep(0.3)
            measurement = evaluate('({requested:manager.settings.dockHeight, '
                'y:background.get_transformed_position()[1],height:background.height, '
                'width:background.width,iconSize:dock.dash.iconSize, '
                'blurY:dock._themeManager._blurActor.get_transformed_position()[1], '
                'targetY:dock._staticBox.y1, exportedY:Main.layoutManager.dashToDockStruts.monitors[dock.monitorIndex].y})')
            results['vertical-position'].append(measurement)
            assert abs(measurement['y']-(baseline['y']-offset))<=1
            assert measurement['height']==baseline['height'] and measurement['width']==baseline['width']
            assert measurement['iconSize']==baseline['iconSize']
            assert abs(measurement['blurY']-measurement['y'])<=1
            assert abs(measurement['targetY']-measurement['exportedY'])<=1
        monitor_bottom = evaluate('dock._monitor.y+dock._monitor.height')
        assert any(m['requested'] < 0 and m['y'] >= monitor_bottom
                   for m in results['vertical-position'])
        evaluate('manager.settings.set_int("dock-height",-120);')
        time.sleep(0.3)
        for _ in range(3):
            evaluate('dock._resetPosition();dock._updateStaticBox();')
            time.sleep(0.1)
            check('offscreen-position-stable', f'Math.abs(background.get_transformed_position()[1]-({baseline["y"]}+120))<=1')
        evaluate('manager.settings.set_int("dock-height",0);themeContext.scale_factor=2;')
        time.sleep(0.5)
        scaled_y = evaluate('background.get_transformed_position()[1]')
        evaluate('manager.settings.set_int("dock-height",32);')
        time.sleep(0.3)
        check('vertical-scale-2', f'Math.abs(background.get_transformed_position()[1]-({scaled_y}-64))<=1')
        evaluate('manager.settings.set_int("dock-height",-32);')
        time.sleep(0.3)
        check('negative-vertical-scale-2', f'Math.abs(background.get_transformed_position()[1]-({scaled_y}+64))<=1')
        evaluate('themeContext.scale_factor=oldScale; manager.settings.set_int("dock-height",0); '
                 'manager.settings.set_enum("dock-position",3);')
        time.sleep(0.5)
        evaluate('globalThis.dock=manager.allDocks[0];globalThis.background=dock.dash._background;')
        side_y = evaluate('background.get_transformed_position()[1]')
        for offset in [40,-40,0]:
            evaluate(f'manager.settings.set_int("dock-height",{offset});')
            time.sleep(0.3)
            check(f'side-vertical-{offset}', f'Math.abs(background.get_transformed_position()[1]-({side_y}-({offset})))<=1')
        evaluate('manager.settings.set_enum("dock-position",0);manager.settings.set_int("dock-height",0);')
        time.sleep(0.4)
        evaluate('globalThis.dock=manager.allDocks[0];globalThis.background=dock.dash._background;')
        top_y = evaluate('background.get_transformed_position()[1]')
        evaluate('manager.settings.set_int("dock-height",-80);')
        time.sleep(0.3)
        check('top-moves-down', f'Math.abs(background.get_transformed_position()[1]-({top_y}+80))<=1')
        evaluate('manager.settings.set_int("dock-height",80);')
        time.sleep(0.3)
        check('top-moves-offscreen', f'Math.abs(background.get_transformed_position()[1]-({top_y}-80))<=1')
        evaluate('manager.settings.set_int("dock-height",0);manager.settings.set_enum("dock-position",2); '
                 'manager.settings.set_boolean("shell-menu-keep-dock-radius",false);')
        time.sleep(0.4)
        evaluate('globalThis.dock=manager.allDocks[0];globalThis.background=dock.dash._background;')
        # Compare real pixels outside the sliding actor, where the shadow must
        # paint before the dock reaches its final position. A stronger themed
        # shadow makes clipping observable on both dark and light backgrounds.
        evaluate('menu.box.set_style("box-shadow: 0 3px 12px 4px rgba(0,0,0,0.6);");')
        time.sleep(0.3)
        for side, name in [(2,'bottom'),(0,'top'),(3,'left'),(1,'right')]:
            evaluate(f'manager.settings.set_enum("dock-position",{side});')
            time.sleep(0.4)
            evaluate('globalThis.dock=manager.allDocks[0];globalThis.background=dock.dash._background; '
                     'dock._slider.slideX=0.5;manager.settings.set_int("dock-shadow-intensity",100);')
            time.sleep(0.3)
            box = evaluate('[...dock._box.get_transformed_position(),...dock._box.get_transformed_size()]')
            on = output / f'{variant}-sliding-shadow-{name}.png'
            off = Path(os.environ['XDG_RUNTIME_DIR']) / 'shadow-off.png'
            screenshot(on)
            evaluate('manager.settings.set_int("dock-shadow-intensity",0);')
            time.sleep(0.3)
            screenshot(off)
            difference = exterior_difference(on, off, box)
            results[f'sliding-shadow-{name}'] = difference
            assert difference['pixels'] > 10, f'No outer shadow while sliding: {name}: {difference}'
            evaluate('dock._slider.slideX=0;manager.settings.set_int("dock-shadow-intensity",100);')
            time.sleep(0.3)
            check(f'{name}-fully-hidden', 'dock._box.has_clip && '
                  'dock._box.get_clip().slice(2).some(size=>size===0)')
        evaluate('menu.box.set_style(originalMenuStyle);manager.settings.set_int("dock-shadow-intensity",100); '
                 'manager.settings.set_enum("dock-position",2);manager.settings.set_boolean("autohide",true); '
                 'manager.settings.set_boolean("dock-fixed",false);')
        time.sleep(0.6)
        # Hold unrelated visibility requests while exercising both animation
        # directions from a known hidden state with autohide enabled.
        evaluate('globalThis.dock=manager.allDocks[0];globalThis.background=dock.dash._background; '
                 'dock._menuOpened=true;dock._ignoreHover=true;dock._updateVisibilityMode(); '
                 'dock._removeAnimations();dock._animateIn(0,0);dock._animateOut(0,0);')
        time.sleep(0.1)
        results['autohide-start-state'] = evaluate('({enabled:dock.autohideEnabled, '
            'fixed:manager.settings.dockFixed,state:dock.dockState,slide:dock._slider.slideX})')
        check('autohide-starts-hidden', 'dock.autohideEnabled && dock._slider.slideX===0')
        evaluate('globalThis.slideFrames=[]; '
                 'globalThis.slideFrameId=global.stage.connect("after-paint",()=> '
                 'slideFrames.push({slide:dock._slider.slideX,clip:dock._box.get_clip(), '
                 'size:[dock._box.width,dock._box.height], '
                 'background:[...background.get_transformed_position(),...background.get_transformed_size()]})); '
                 'dock._animateIn(0.4,0);')
        time.sleep(0.6)
        evaluate('dock._animateOut(0.4,0);')
        time.sleep(0.6)
        results['autohide-shadow-frames'] = evaluate('slideFrames')
        evaluate('global.stage.disconnect(slideFrameId);')
        moving = [f for f in results['autohide-shadow-frames'] if 0 < f['slide'] < 1]
        assert len(moving) > 3, 'Autohide did not animate'
        fractions = [f['slide'] for f in results['autohide-shadow-frames']]
        assert any(b > a for a,b in zip(fractions,fractions[1:])), 'No slide-in animation'
        assert any(b < a for a,b in zip(fractions,fractions[1:])), 'No slide-out animation'
        assert all(f['clip'][2] > f['size'][0] and f['clip'][3] > f['size'][1] for f in moving)
        evaluate('delete dock._menuOpened;manager.settings.set_boolean("dock-fixed",true);')
        time.sleep(0.6)
        time.sleep(1)
        evaluate('globalThis.frames=0; globalThis.frameId=global.stage.connect("after-paint",()=>frames++);')
        time.sleep(1.5)
        results['idle-frames'] = evaluate('frames')
        evaluate('global.stage.disconnect(frameId);')
        if results['idle-frames'] > 2:
            raise AssertionError('Unexpected idle repaints')

        evaluate('manager.settings.set_boolean("shell-menu-style",false); '
                 'manager.settings.set_boolean("force-straight-corner",true); '
                 'manager.settings.set_int("dock-blur-corner-radius",0); '
                 'manager.settings.set_enum("transparency-mode",1); '
                 'manager.settings.set_double("background-opacity",1);')
        time.sleep(0.8)
        evaluate('global.stage.queue_redraw();')
        time.sleep(0.2)
        check('opaque-blur-hidden', 'surfaceValues(background).corners.every(v=>v===0) && '
              '!dock._themeManager._blurActor.mapped && !dock._themeManager._blurRepaintLater')
        check('opaque-no-redraw-guard', '''(() => {
            const Clutter=imports.gi.Clutter;
            return (Clutter.get_debug_flags()[1] & Clutter.DrawDebugFlag.DISABLE_CLIPPED_REDRAWS)===0;
        })()''')
        evaluate('globalThis.frames=0;frameId=global.stage.connect("after-paint",()=>frames++);')
        time.sleep(1.5)
        results['idle-frames-opaque'] = evaluate('frames')
        evaluate('global.stage.disconnect(frameId);')
        assert results['idle-frames-opaque'] <= 2
        evaluate('manager.settings.set_double("background-opacity",0.55);')
        time.sleep(0.4)
        check('transparent-blur-restored', 'dock._themeManager._blurActor.mapped')

        evaluate('extension.disable();')
        check('disable-cleanup', '!Main.uiGroup.get_children().some(a=>a.name === "dashtodockContainer")')
        evaluate('extension.enable();')
        check('reenable', 'manager.allDocks.length > 0')
        evaluate('backdrop.hide();')
        display_env = dict(os.environ, WAYLAND_DISPLAY='wayland-0', GDK_BACKEND='wayland', LANGUAGE='pt_BR', LANG='pt_BR.UTF-8', LC_ALL='pt_BR.UTF-8',
                           GSETTINGS_BACKEND='memory',
                           GI_TYPELIB_PATH='/usr/lib64/gnome-shell/girepository-1.0:/usr/lib64/gnome-shell')
        capture = Path(os.environ['XDG_RUNTIME_DIR']) / 'prefs-capture'
        capture.mkdir()
        display_env['SOFT_PREFS_CAPTURE_DIR'] = str(capture)
        prefs = subprocess.Popen(['gjs', '-m', str(ROOT / 'tests/shell-menu-prefs.mjs'), str(Path(os.environ['XDG_DATA_HOME']) / 'gnome-shell/extensions' / UUID)],
                                 env=display_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            for phase in ['position','appearance']:
                (capture / 'command').write_text(phase)
                deadline = time.monotonic()+12
                while True:
                    if prefs.poll() is not None:
                        raise RuntimeError(prefs.communicate()[1])
                    try:
                        layout = json.loads((capture / 'ready').read_text())
                        if layout['phase'] == phase:
                            break
                    except (FileNotFoundError,json.JSONDecodeError):
                        pass
                    if time.monotonic()>deadline:
                        raise RuntimeError('Preferences capture timed out')
                    time.sleep(0.1)
                results[f'preferences-{phase}-layout'] = layout['bounds']
                if phase == 'position':
                    label_ids=['dock_size_label','dock_height_label','builtin_theme_label6','builtin_theme_label7']
                    scale_ids=['dock_size_scale','dock_height_scale','icon_size_scale','preview_size_scale']
                    labels=[layout['bounds'][name] for name in label_ids]
                    scales=[layout['bounds'][name] for name in scale_ids]
                    assert max(b['x'] for b in labels)-min(b['x'] for b in labels)<=1, 'Label alignment'
                    assert max(b['x'] for b in scales)-min(b['x'] for b in scales)<=1, 'Slider alignment'
                    assert all(l['x']+l['width']<=c['x'] for l,c in zip(labels,scales)), 'Label/control overlap'
                else:
                    scales=list(layout['bounds'].values())
                    assert max(b['x'] for b in scales)-min(b['x'] for b in scales)<=1, 'Appearance slider alignment'
                    assert max(b['width'] for b in scales)-min(b['width'] for b in scales)<=1, 'Appearance slider widths'
                screenshot = json.dumps(str(output / f'{variant}-preferences-{phase}.png'))
                evaluate(f'(async()=>{{const stream=Gio.File.new_for_path({screenshot}).replace(null,false, '
                         'Gio.FileCreateFlags.REPLACE_DESTINATION,null);await new Shell.Screenshot().screenshot(false,stream);'
                         'stream.close(null);return true;})()')
            (capture / 'command').write_text('done')
            stdout,stderr=prefs.communicate(timeout=10)
            results['preferences'] = {'passed':prefs.returncode==0,'output':stdout.strip()}
            if prefs.returncode:
                raise RuntimeError(stderr)
        finally:
            if prefs.poll() is None:
                prefs.terminate()
                prefs.wait(timeout=5)
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
