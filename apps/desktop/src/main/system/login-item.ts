export function loginItemSync(set: (openAtLogin: boolean) => void, log: (err: unknown) => void = (err) => console.error('launch at login unavailable', err)) {
  let current = false
  let logged = false
  return (openAtLogin: boolean) => {
    if (openAtLogin === current) return
    current = openAtLogin
    try {
      set(openAtLogin)
    } catch (err) {
      if (!logged) log(err)
      logged = true
    }
  }
}
