import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useSettings } from '@/app/settings'
import { Wordmark } from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { SelectField } from '@/components/ui/Field'
import { useToast } from '@/components/ui/Toast'
import { useUpdateProfile } from '@/data/hooks'
import { browserTimeZone } from '@/lib/dates'
import { friendlyError } from '@/lib/errors'
import { AccountForm } from './Accounts'
import { TIME_ZONES } from './Profile'

/** First run: one account and a timezone, then straight to Home. */
export function Onboarding() {
  const { profile, accounts } = useSettings()
  const navigate = useNavigate()
  const toast = useToast()
  const updateProfile = useUpdateProfile()
  const deviceZone = browserTimeZone()
  const [timeZone, setTimeZone] = useState(TIME_ZONES.includes(deviceZone) ? deviceZone : profile.timezone)

  async function finish() {
    try {
      if (timeZone !== profile.timezone) await updateProfile.mutateAsync({ id: profile.id, patch: { timezone: timeZone } })
    } catch (error) {
      toast({ message: friendlyError(error), tone: 'error' })
    }
    toast({ message: 'You’re all set. Tap + to record your first entry.' })
    navigate('/', { replace: true })
  }

  return (
    <div className="flex flex-col gap-6 pb-10">
      <header className="flex flex-col gap-2 pt-6">
        <Wordmark className="text-6xl" />
        <p aria-hidden="true" className="scribble -rotate-2 text-3xl text-orange-press">
          hi{profile.display_name ? ` ${profile.display_name.split(' ')[0]}` : ''}! let&rsquo;s set you up.
        </p>
        <h1 className="display mt-2 text-[2.15rem]">{accounts.length > 0 ? 'Add another account' : 'Where does your money live?'}</h1>
        <p className="text-muted">
          Start with the account you use most — a bank account, your wallet cash or a credit card. You can add more any time.
        </p>
      </header>

      <Card shadow="lg">
        <AccountForm submitLabel="Start tracking" onSaved={() => void finish()} />
      </Card>

      <Card tone="peach">
        <SelectField
          label="Your timezone"
          value={timeZone}
          onChange={(e) => setTimeZone(e.target.value)}
          hint="Used to decide which day, week and month an entry belongs to."
        >
          {(TIME_ZONES.includes(timeZone) ? TIME_ZONES : [timeZone, ...TIME_ZONES]).map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </SelectField>
      </Card>
    </div>
  )
}
