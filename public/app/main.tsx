import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { d } from './lib.ts'

console.log('ok', d)

createRoot(document.getElementById('root')!).render(<App />)
