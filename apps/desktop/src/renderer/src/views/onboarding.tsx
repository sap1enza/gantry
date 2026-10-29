import { ArrowLeft, ArrowRight, ArrowUpRight, Blocks, Check, CircleCheck, CircleDashed, Lock, Mail, SquareTerminal } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useApp } from '../app'
import { api } from '../bridge'
import { Button, Github, OAUTH_INPUTS, SOURCE_LABELS, SourceIcon, Tag } from '../ui'
import { useBrowserAuth } from './connections'
import { AgentSettings, WorkspaceCleanupRow } from './preferences'

const HINTS = { github: 'Pull requests, issues, and alerts' } as const
const STEPS = ['You', 'Inputs', 'Agents'] as const

export function Onboarding() {
  const app = useApp()
  const [step, setStep] = useState(0)
  const [name, setName] = useState(app.account?.name ?? '')
  const [email, setEmail] = useState('')
  const auth = useBrowserAuth()
  const acc = app.account
  const statusOf = (provider: string) => app.connections.find((c) => c.provider === provider)?.status

  const saveName = async () => {
    if (name.trim() !== acc?.name) await app.run(api.account.setName(name.trim()))
    await app.reloadAccount()
  }
  const signIn = async (method: 'github' | 'email') => {
    if ((await auth.start(api.account.setName(name.trim()).then(() => api.account.signIn(method, method === 'email' ? email : undefined)))) && method === 'email') app.toast(`Magic link sent to ${email}`)
  }
  const finish = async () => {
    await app.run(api.account.completeOnboarding())
    await app.reloadAccount()
  }
  const next = async () => {
    if (step === STEPS.length - 1) return finish()
    setStep(step + 1)
    if (step === 0) await saveName()
  }

  const pages: Record<(typeof STEPS)[number], { title: string; sub: string; body: ReactNode }> = {
    You: {
      title: 'Welcome to Gantry',
      sub: 'A quiet place to triage work and dispatch agents. Tell us what to call you.',
      body: (
        <div className="rows">
          <div className="pref-row">
            <b className="grow">Your name</b>
            <input className="field" style={{ width: 240 }} autoFocus aria-label="Your name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && next()} />
          </div>
          <div className="pref-row">
            <div className="grow">
              <b>Sign in</b>
              <p className="small muted">Optional. Signing in with GitHub also connects it as an input.</p>
            </div>
            {acc?.signedIn ? (
              <Tag tone="green">Signed in{acc.githubLogin ? ` as ${acc.githubLogin}` : acc.email ? ` as ${acc.email}` : ''}</Tag>
            ) : (
              <Button className="btn" disabled={!name.trim()} onClick={() => signIn('github')}>
                <Github size={13} /> GitHub
              </Button>
            )}
          </div>
          {!acc?.signedIn && (
            <div className="pref-row">
              <b className="grow">Or sign in with email</b>
              <input className="field" type="email" style={{ width: 200 }} placeholder="you@company.com" aria-label="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
              <Button className="btn" disabled={!name.trim() || !/^\S+@\S+\.\S+$/.test(email)} onClick={() => signIn('email')}>
                <Mail size={13} /> Send link
              </Button>
            </div>
          )}
          {auth.banner}
        </div>
      ),
    },
    Inputs: {
      title: 'Connect your inputs',
      sub: 'Start with one. Choose repositories and triggers later in Connections.',
      body: (
        <div className="rows">
          {OAUTH_INPUTS.map(({ provider, kind }) => (
            <div key={provider} className="pref-row">
              <SourceIcon kind={kind} size={17} />
              <div className="grow">
                <b>{SOURCE_LABELS[kind]}</b>
                <p className="small muted">{HINTS[provider]}</p>
              </div>
              {statusOf(provider) === 'connected' ? (
                <Tag tone="green">Connected</Tag>
              ) : (
                <Button className="btn" onClick={() => auth.start(api.connections.connect(provider))}>
                  <ArrowUpRight size={12} /> {statusOf(provider) === 'reconnect_required' ? 'Reconnect' : 'Connect'}
                </Button>
              )}
            </div>
          ))}
          {auth.banner}
          <div className="pref-row small muted">
            <Lock size={11} /> Secure OAuth · Revoke access anytime
          </div>
        </div>
      ),
    },
    Agents: {
      title: 'Set up agents',
      sub: 'Where agents work, what they may do, and what happens to their workspace when a card is Done.',
      body: (
        <div className="rows">
          <div className="pref-row">
            <SquareTerminal size={15} />
            <span className="grow">
              {app.checks?.claude.available ? `Claude Code${app.checks.claude.version ? ` ${app.checks.claude.version}` : ''} is available` : `Claude Code not found — ${app.checks?.claude.reason ?? 'install it and add it to PATH'}`}
            </span>
            {app.checks?.gh.authenticated ? <CircleCheck size={14} color="var(--green)" /> : <CircleDashed size={14} />}
            <span className="small muted">{app.checks?.gh.authenticated ? 'GitHub CLI authenticated' : 'Run gh auth login for the Full preset'}</span>
          </div>
          <AgentSettings />
          <WorkspaceCleanupRow />
        </div>
      ),
    },
  }
  const page = pages[STEPS[step]!]

  return (
    <div className="onboarding">
      <div className="onboarding-drag" />
      <div className="onboarding-inner">
        <div className="row">
          <div className="logo">
            <Blocks size={15} />
          </div>
          <b>Gantry</b>
          <ol className="onboarding-steps">
            {STEPS.map((label, i) => (
              <li key={label} className={i === step ? 'current' : i < step ? 'complete' : ''}>
                <span className="step-n">{i < step ? <Check size={11} /> : i + 1}</span>
                {label}
              </li>
            ))}
          </ol>
        </div>
        <div>
          <h1>{page.title}</h1>
          <p className="muted">{page.sub}</p>
        </div>
        {page.body}
        <div className="row">
          {step > 0 && (
            <Button className="btn" onClick={() => setStep(step - 1)}>
              <ArrowLeft size={13} /> Back
            </Button>
          )}
          <div className="grow" />
          {step > 0 && step < STEPS.length - 1 && (
            <Button className="btn ghost" onClick={() => setStep(step + 1)}>
              Skip
            </Button>
          )}
          <Button className="btn primary" disabled={!name.trim()} onClick={next}>
            {step === STEPS.length - 1 ? 'Open Gantry' : 'Continue'} <ArrowRight size={13} />
          </Button>
        </div>
      </div>
    </div>
  )
}
