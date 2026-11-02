import { atom } from 'jotai'
import type { Hb, HbHongbao, HbMe, HbMyView, HbViewer } from '../types/hb-sdk'
import type { UploadResult } from '../shared/contracts'

export interface PlatformSession {
  status: 'connecting' | 'connected' | 'standalone' | 'error'
  sdk?: Hb
  hongbao?: HbHongbao
  viewer?: HbViewer
  participantStatus?: 'checking' | 'ready' | 'error'
  me?: HbMe
  myView?: HbMyView | null
  error?: string
}

export const sessionAtom = atom<PlatformSession>({ status: 'connecting' })
export const noticeAtom = atom<{ kind: 'info' | 'error' | 'success'; text: string } | null>(null)
export const resultAtom = atom<UploadResult | null>(null)
export const phaseAtom = atom<'idle' | 'identity' | 'processing' | 'submitting'>('idle')
export const instructionsAtom = atom(true)
