export class EigenGridError extends Error {
  constructor(
    public code: string,
    message: string,
    public hint?: string,
  ) {
    super(message);
    this.name = "EigenGridError";
  }
}

export class NotImplementedError extends EigenGridError {
  constructor(feature: string) {
    super(
      "NOT_IMPLEMENTED",
      `${feature} is not implemented`,
      "This feature is not available in this version",
    );
    this.name = "NotImplementedError";
  }
}

export class ConfigError extends EigenGridError {
  constructor(message: string, hint?: string) {
    super("CONFIG_ERROR", message, hint);
    this.name = "ConfigError";
  }
}

export class PythonBridgeError extends EigenGridError {
  constructor(message: string, hint?: string) {
    super("PYTHON_BRIDGE_ERROR", message, hint);
    this.name = "PythonBridgeError";
  }
}

export class PermissionDeniedError extends EigenGridError {
  public readonly action: string;
  public readonly resource: string;

  constructor(action: string, resource: string, message?: string) {
    super(
      "PERMISSION_DENIED",
      message ?? `Permission denied: action '${action}' on resource '${resource}' is not allowed.`,
      "Update the permission ruleset or use a different action/resource combination.",
    );
    this.name = "PermissionDeniedError";
    this.action = action;
    this.resource = resource;
  }
}
