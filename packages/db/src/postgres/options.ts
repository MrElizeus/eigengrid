export interface PostgresDatabaseOptions {
  /** Applying DDL is an explicit migration capability, not a runtime requirement. */
  migrations?: "apply" | "validate";
}
