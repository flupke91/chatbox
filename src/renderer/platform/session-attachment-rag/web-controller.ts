import { MobileRagDatabase } from './mobile/db'
import { MobileLocalRagEngine } from './mobile/engine'
import { MobileSessionAttachmentRagController } from './mobile-controller'
import { SqlJsConnection } from './web/sqljs-adapter'

/**
 * Browser implementation of the session-attachment RAG controller.
 *
 * There is no native SQLite in a browser/PWA, so the engine runs on sql.js (SQLite compiled to
 * WebAssembly) with the database snapshotted into IndexedDB. Everything above the driver — schema,
 * chunking, scoring SQL, spoiler filter, FTS fallback — is shared with the Android/iOS build,
 * which keeps behaviour identical across platforms.
 */
export class WebSessionAttachmentRagController extends MobileSessionAttachmentRagController {
  constructor() {
    const connection = new SqlJsConnection()
    const database = new MobileRagDatabase(connection as unknown as ConstructorParameters<typeof MobileRagDatabase>[0])
    super(new MobileLocalRagEngine({ database }))
  }
}
