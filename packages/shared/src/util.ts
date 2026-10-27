export const unique = <T>(xs: T[]) => [...new Set(xs)]
export const without = <T>(xs: T[], ...remove: T[]) => xs.filter((x) => !remove.includes(x))
export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))
