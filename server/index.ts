import express from 'express'
import cors from 'cors'
import path from 'path'
import fs from 'fs'
import './db/index.js'
import routes from './api/routes.js'
import { runIngestion } from './ingestion/index.js'

const app = express()
const PORT = parseInt(process.env.PORT || '3001', 10)
const FRONTEND_PORT = parseInt(process.env.FRONTEND_PORT || '4173', 10)
const FRONTEND_DEV_URL = `http://127.0.0.1:${FRONTEND_PORT}`
const IS_PROD = process.env.NODE_ENV === 'production'

app.use(cors({ origin: [FRONTEND_DEV_URL, `http://localhost:${FRONTEND_PORT}`] }))
app.use(express.json())

// API routes
app.use('/api', routes)

// Serve built frontend in production
if (IS_PROD) {
  const clientDist = path.join(process.cwd(), 'dist', 'client')
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist))
    app.get('*', (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'))
    })
  }
}

app.listen(PORT, '127.0.0.1', async () => {
  console.log(`\n  Tokend API  →  http://127.0.0.1:${PORT}`)
  if (IS_PROD) {
    console.log(`  Frontend       →  http://127.0.0.1:${PORT}`)
  } else {
    console.log(`  Frontend dev   →  ${FRONTEND_DEV_URL}`)
  }
  console.log(`  Running initial ingestion...`)
  try {
    const stats = await runIngestion(false)
    console.log(`  Ingestion complete: ${stats.eventsInserted} new events from ${stats.filesProcessed} files (${stats.duration}ms)`)
  } catch (e) {
    console.error(`  Ingestion error:`, e)
  }
  console.log()
})
