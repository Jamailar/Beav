export class Log {
    private tags: Record<string, any> = {};

    constructor(tags: Record<string, any> = {}) {
        this.tags = tags;
    }

    static create(tags: Record<string, any> = {}) {
        return new Log(tags);
    }

    clone() {
        return new Log({ ...this.tags });
    }

    tag(key: string, value: any) {
        this.tags[key] = value;
        return this;
    }

    info(message: string, data?: any) {
        console.log(JSON.stringify({ level: 'info', message, ...this.tags, ...data }));
    }

    error(message: string, data?: any) {
        console.error(JSON.stringify({ level: 'error', message, ...this.tags, ...data }));
    }
}
