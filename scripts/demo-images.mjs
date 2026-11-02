import { Buffer } from 'node:buffer'
import { deflateSync } from 'node:zlib'

// Original, harmless geometric illustrations for the local simulator only.
// Real PNG files let the same decoder, R2, and image endpoints run in the demo.
const palettes = [
  ['#e8d8c5', '#b57e62', '#f3e7d7', '#43382f'],
  ['#c7d9d0', '#5d8378', '#e7eae0', '#293e38'],
  ['#d8dfec', '#7a92b6', '#f5e6bf', '#354564'],
  ['#ead8d0', '#be847e', '#f3ece5', '#5d3e3d'],
]

function crc32(bytes) {
  let crc = 0xffffffff
  for (const value of bytes) {
    crc ^= value
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, bytes) {
  const label = Buffer.from(type)
  const result = Buffer.alloc(bytes.length + 12)
  result.writeUInt32BE(bytes.length)
  label.copy(result, 4)
  bytes.copy(result, 8)
  result.writeUInt32BE(crc32(Buffer.concat([label, bytes])), bytes.length + 8)
  return result
}

export function demoImage(index = 0) {
  const width = 480
  const height = [600, 400, 540, 440][index % 4]
  const colors = palettes[index % palettes.length].map(hex => [1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16)))
  const rows = Buffer.alloc((width * 3 + 1) * height)
  const ellipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 < 1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = x / width, ny = y / height
      let color = colors[0]
      if (index % 3 === 0) {
        // A sleeping cat on a broad window ledge.
        if (ny > .79) color = colors[1]
        if (ellipse(nx, ny, .53, .67, .29, .17)) color = colors[2]
        if (ellipse(nx, ny, .34, .56, .15, .14)) color = colors[2]
        if (ny > .33 && ny < .5 && Math.abs(nx - .245) < (ny - .33) * .56) color = colors[2]
        if (ny > .33 && ny < .5 && Math.abs(nx - .415) < (ny - .33) * .56) color = colors[2]
        if (ny > .565 && ny < .575 && ((nx > .25 && nx < .30) || (nx > .36 && nx < .41))) color = colors[3]
        if (ellipse(nx, ny, .332, .614, .012, .009)) color = colors[1]
      } else if (index % 3 === 1) {
        // Quiet hills and a sun.
        if (ellipse(nx, ny, .73, .27, .105, .105 * width / height)) color = colors[2]
        if (ny > .64 - .13 * Math.sin(nx * 5.5)) color = colors[1]
        if (ny > .83 - .12 * Math.cos(nx * 5)) color = colors[3]
      } else {
        // Still life: a vase, leaves, and table.
        if (ny > .81) color = colors[1]
        if (ny > .48 && ny < .82 && Math.abs(nx - .5) < .10 + .065 * Math.sin((ny - .48) * 9)) color = colors[2]
        if (ny > .19 && ny < .50 && Math.abs(nx - (.5 + (ny - .45) * .18)) < .006) color = colors[3]
        if (ellipse(nx, ny, .40, .30, .10, .035) || ellipse(nx, ny, .56, .22, .10, .035) || ellipse(nx, ny, .58, .40, .09, .03)) color = colors[1]
      }
      const at = y * (width * 3 + 1) + 1 + x * 3
      rows[at] = color[0]; rows[at + 1] = color[1]; rows[at + 2] = color[2]
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4)
  header[8] = 8; header[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}
