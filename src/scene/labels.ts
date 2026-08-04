import * as THREE from 'three'

/** Canvas-texture text sprite — cheap, crisp and always camera-facing. */
export function makeTextSprite(
  text: string,
  opts: {
    color?: string
    background?: string
    border?: string
    fontSize?: number
    padding?: number
    worldHeight?: number
    bold?: boolean
    rounded?: boolean
  } = {},
): THREE.Sprite {
  const {
    color = '#e6edf5',
    background = 'rgba(9,13,20,0.82)',
    border = 'rgba(255,255,255,0.18)',
    fontSize = 64,
    padding = 22,
    worldHeight = 1,
    bold = true,
    rounded = true,
  } = opts

  const dpr = 2
  const measureCanvas = document.createElement('canvas')
  const mctx = measureCanvas.getContext('2d')!
  const font = `${bold ? '700' : '500'} ${fontSize}px Inter, system-ui, sans-serif`
  mctx.font = font
  const textWidth = mctx.measureText(text).width

  const w = Math.ceil(textWidth + padding * 2)
  const h = Math.ceil(fontSize * 1.42 + padding)

  const canvas = document.createElement('canvas')
  canvas.width = w * dpr
  canvas.height = h * dpr
  const ctx = canvas.getContext('2d')!
  ctx.scale(dpr, dpr)
  ctx.font = font
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  if (background !== 'transparent') {
    ctx.fillStyle = background
    if (rounded) {
      const r = Math.min(h / 2, 18)
      roundRect(ctx, 1, 1, w - 2, h - 2, r)
      ctx.fill()
      if (border !== 'transparent') {
        ctx.strokeStyle = border
        ctx.lineWidth = 2
        ctx.stroke()
      }
    } else {
      ctx.fillRect(0, 0, w, h)
    }
  }

  ctx.fillStyle = color
  ctx.fillText(text, w / 2, h / 2 + 1)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.generateMipmaps = false

  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false }),
  )
  sprite.scale.set((worldHeight * w) / h, worldHeight, 1)
  sprite.renderOrder = 20
  return sprite
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

export function disposeSprite(sprite: THREE.Sprite): void {
  const mat = sprite.material as THREE.SpriteMaterial
  mat.map?.dispose()
  mat.dispose()
}
