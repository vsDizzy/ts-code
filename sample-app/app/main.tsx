import { createRoot } from 'react-dom/client'
import { App } from './App'
import { d } from './lib'

console.log('ok', d)

createRoot(document.getElementById('root')!).render(<App />)
