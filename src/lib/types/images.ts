import { testType } from "./misc";

export type ImageList = Map<string, ServerImage>;

export type ServerImage = {
    id: string;
    file: string;
    folder: string;
    modifiedDate: number;
    createdDate: number;
    prompt?: string;
    workflow?: string;
    preview?: string;
};
export function isServerImage(object: any): object is ServerImage {
    return testType(object, ['id', 'file', 'folder', 'modifiedDate', 'createdDate']);
}

export type ClientImage = {
    id: string;
    url: string;
    type?: 'image' | 'video';
};
export function isClientImage(object: any): object is ClientImage {
    return testType(object, ['id', 'url']);
}

export type ImageInfo = {
    id: string;
    folder: string;
    modifiedDate: number;
    createdDate: number;
    prompt?: string;
    workflow?: string;
};
export function isImageInfo(object: any): object is ImageInfo {
    return testType(object, ['id', 'folder', 'modifiedDate', 'createdDate']);
}

export type ComfyNode = {
    inputs: Record<string, (string|number|boolean|[string, number]|object)>;
    class_type: string;
}
export type ComfyPrompt = Record<string, ComfyNode>;

export type ComfyWorkflow = {
    nodes: ComfyWorkflowNode[];
    links: [number, number, number, number, number, string][];
    groups: any[];
    config: any;
    version: number;
}

export type ComfyWorkflowNode = {
    id: number;
    type: string;
    title?: string;
    pos: [number, number];
    size: { "0": number, "1": number; };
    flags: Record<string, boolean>;
    order: number;
    mode: number;
    inputs: {
        name: string;
        type: string;
        link: number;
        widget?: { name: string; };
        dir?: number;
        has_old_label?: boolean;
        label?: string;
        old_label?: string;
    }[];
    outputs: {
        name: string;
        type: string;
        links: number[];
        shape?: number;
        dir?: number;
        has_old_label?: boolean;
        label?: string;
        old_label?: string;
        slot_index?: number;
    }[];
    widgets_values: (string|number|boolean)[];
    properties: Record<string, string>;
    shape: number;
}

export type ImageExtraData = {
    id: string;
    simplifiedPrompt?: string;
    comfyPositive?: string;
    comfyNegative?: string;
}