const fs = require('node:fs')
const path = require('node:path')

function cleanBuildArtifactsInDir(dir) {
  if (!fs.existsSync(dir)) return
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      cleanBuildArtifactsInDir(fullPath)
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.js.map') ||
        entry.name.endsWith('.mjs.map') ||
        entry.name.endsWith('.css.map') ||
        entry.name === 'stats.html')
    ) {
      try {
        fs.unlinkSync(fullPath)
      } catch {}
    }
  }
}

const rootDist = path.join(__dirname, '../../release/app/dist')
cleanBuildArtifactsInDir(rootDist)
