import { EventEmitter } from 'events';

export const Bus = new EventEmitter();

export namespace BusEvent {
    export function define(type: string, schema: any) {
        return { type, properties: schema };
    }
}
