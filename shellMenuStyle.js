// SPDX-License-Identifier: GPL-2.0-or-later
// ThemeNode lengths and StShadow fields are already in physical pixels.
// Inline St CSS is in logical pixels, so divide once before serializing.
function colorCss(color) {
    return `rgba(${color.red}, ${color.green}, ${color.blue}, ${color.alpha / 255})`;
}

export function shellMenuSurfaceStyle(node, scale) {
    const sides = ['top', 'right', 'bottom', 'left'];
    let style = sides.map((side, i) =>
        `border-${side}: ${node.get_border_width(i) / scale}px solid ${colorCss(node.get_border_color(i))};`)
        .join('');
    const radii = sides.map((_side, i) => `${node.get_border_radius(i) / scale}px`);
    style += `border-radius: ${radii.join(' ')};`;
    const shadow = node.get_box_shadow();
    if (shadow) {
        const lengths = [shadow.xoffset, shadow.yoffset, shadow.blur, shadow.spread]
            .map(value => `${value / scale}px`).join(' ');
        style += `box-shadow: ${shadow.inset ? 'inset ' : ''}${lengths} ${colorCss(shadow.color)};`;
    } else {
        style += 'box-shadow: none;';
    }
    return style;
}
