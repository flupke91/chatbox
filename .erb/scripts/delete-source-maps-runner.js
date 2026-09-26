const fs = require('fs')
const path = require('path')

function cleanMapsInDir(dir) {
  if (!fs.existsSync(dir)) return
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      cleanMapsInDir(fullPath)
    } else if (entry.isFile() && entry.name.endsWith('.js.map')) {
      try {
        fs.unlinkSync(fullPath)
      } catch {}
    }
  }
}

const rootDist = path.join(__dirname, '../../release/app/dist')
cleanMapsInDir(rootDist)
