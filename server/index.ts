import express from 'express'
import cors from 'cors'
import path from 'path'
import fs from 'fs'
import './db/index.js'
import routes from './api/routes.js'
import { runIngestion } from './ingestion/index.js'

const app = express()
const PORT = parseInt(process.env.PORT || '3001', 10)
const IS_PROD = process.env.NODE_ENV === 'production'

app.use(cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] }))
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
  console.log(`\n  ClawMeter API  →  http://127.0.0.1:${PORT}`)
  if (!IS_PROD) {
    console.log(`  Frontend dev   →  http://localhost:5173`)
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
