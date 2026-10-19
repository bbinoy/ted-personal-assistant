---
name: draw
description: Use when a picture says it better than words - a diagram, flowchart, bar or line chart, itinerary, schematic map, floor plan, icon or rough sketch - or when the person asks you to draw, sketch or chart something. You write an SVG, the draw tool renders it, you check the preview, then send it with the send tool.
---

# Draw

You write an SVG; code renders it to a PNG and shows it to you. It is a sketch, not a photo: say so plainly if the person expects more, and never promise a photo, a realistic or painterly picture, or a logo of a real brand.

## How

1. Call `draw` with the full SVG. Start with `<svg viewBox="0 0 800 600" width="800" height="600">` (pick a size that fits the content; 800 wide is a good default for a phone).
2. Look at the preview you get back. If text overlaps, is cut off or too small, fix the SVG and call `draw` once more. Do not loop more than once or twice.
3. Send it with `send(picture: "img1", caption: "...")`, then say in your reply what it shows. A drawing goes only to this conversation.

## What makes a good drawing

- Text at least 14 px at the final size, short labels, one font (leave `font-family` as `Helvetica, Arial, sans-serif`). Emoji may not render: use words or simple shapes.
- Few colours (two or three plus grey), good contrast on the white background, no overlapping shapes or labels. Leave a margin of 20 px or more inside the viewBox.
- Use plain attributes (`fill`, `stroke`, `font-size`), not CSS classes or `<style>`. Allowed: rect, circle, ellipse, line, polyline, polygon, path, text, tspan, g, defs, gradients, clipPath, marker, `use` of a shape in the same file. Not drawn: scripts, styles, images, links, filters, animation. Anything else is removed, and the tool tells you what.
- Keep it simple: a few dozen shapes, not hundreds. Large path data fails.
- Arrows: define a `<marker>` in `<defs>` and use `marker-end="url(#arrow)"`.

## Charts and numbers

Every number in a chart comes from data you were given or looked up in this conversation. Never invent values to make a chart look complete; if a value is missing, leave it out and say so. Label the axes and the units, start bars at zero, and write the values on the bars when there are few.

## Itineraries and maps

A schematic map or route is a diagram (places as labelled dots, lines between them), not a true-to-scale map. Say that it is schematic. Times and distances come from your sources.
