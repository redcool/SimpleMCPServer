/**
 * Shared types for Unity SimpleMCPBridge communication.
 */

/** Reference to a Unity GameObject returned from the bridge. */
export interface UnityObjectRef {
  instanceId: number;
  name: string;
  type: string;
}

/** JSON-RPC request sent to the Unity bridge. */
export interface MCPRequest {
  id: string;
  method: string;
  paramsJson: string;
}

/** JSON-RPC response from the Unity bridge. */
export interface MCPResponse {
  id: string;
  /** Raw JSON value of the result (stringified). */
  result?: string;
  /** Error message if the request failed. */
  error?: string;
}

/** A single node in the scene hierarchy tree. */
export interface HierarchyEntry {
  instanceId: number;
  name: string;
  active: boolean;
  position: [number, number, number];
  components: string[];
  children: HierarchyEntry[];
}

/** Create object parameters. */
export interface CreateObjectParams {
  name?: string;
  parentId?: number;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
}

/** Set transform parameters. */
export interface SetTransformParams {
  instanceId: number;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
}

/** Set component property parameters. */
export interface SetComponentPropertyParams {
  instanceId: number;
  componentType: string;
  propertyName: string;
  value: unknown;
}

/** Delete object parameters. */
export interface DeleteObjectParams {
  instanceId: number;
}
