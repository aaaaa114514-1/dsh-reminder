declare module 'schemastery' {
  type Schema<T> = {
    ['~standard']: { validate(input: unknown): { value: T } | { issues: unknown[] } }
  }

  const z: {
    object<T extends Record<string, unknown>>(shape: T): Schema<{ [K in keyof T]?: unknown }>
    boolean(): unknown
  }

  export default z
}
