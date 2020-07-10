const { EventEmitter } = require('events');
const deepEqual = require('deep-equal');

// Source: https://stackoverflow.com/a/16608045
const isArray = (x) => (!!x) && (x.constructor === Array);
const isObject = (x) => (!!x) && (x.constructor === Object);

class StatusTracker extends EventEmitter {
    constructor(eventName, { initial = null, deep = false, allowed = true } = {}) {
        super();

        this.eventName = eventName;
        this.deepStatus = deep;
        this.allowedValues = allowed;

        this.currentStatus = initial;
        this.prevStatus = null;
    }

    set(newStatus, forceUpdate = false) {
        const arrayCheckFail = isArray(this.allowedValues) && !this.allowedValues.includes(newStatus);
        const objectCheckFail = isObject(this.allowedValues) && !Object.values(this.allowedValues).includes(newStatus);
        
        if (arrayCheckFail || objectCheckFail)
            throw new Error(`Status tracker of event '${this.eventName}' received invalid status '${newStatus}'`);

        this.prevStatus = this.currentStatus;
        this.currentStatus = newStatus;

        if (!this.deepStatus) {
            if (forceUpdate || this.currentStatus != this.prevStatus)
                this.emit(this.eventName, this.currentStatus, this.prevStatus, forceUpdate);
        } else {
            if (forceUpdate || !deepEqual(this.currentStatus, this.prevStatus))
                this.emit(this.eventName, this.currentStatus, this.prevStatus, forceUpdate);
        }
    }

    get() {
        return this.currentStatus;
    }

    forceUpdate() {
        this.set(this.currentStatus, true);
    }

    addHook(fn) {
        if (!this.rawListeners(this.eventName).includes(fn))
            this.on(this.eventName, fn);
    }

    removeHook(fn) {
        this.off(this.eventName, fn);
    }

    removeAllHooks() {
        this.removeAllListeners(this.eventName);
    }

    waitForStatusLogic(checkPredicate, timeout) {
        const that = this;

        if (timeout <= 0)
            throw new Error('Timeout length must be a positive non-zero number in milliseconds!');

        return new Promise((resolve, reject) => {
            const oldDate = +new Date();

            function statusScanner(newStatus) {
                const newDate = +new Date();
                if (checkPredicate(newStatus)) {
                    resolve();
                    that.removeHook(statusScanner);
                } else if ((newDate - oldDate) > timeout) {
                    reject(`Timeout exceeded specified limit for status tracker '${this.eventName}'!`);
                    that.removeHook(statusScanner);
                }
            }

            this.addHook(statusScanner);
        });
    }
}

class StatusTrackerMap {
    constructor() {
        this.trackers = {};
    }

    addTracker(eventName, options = {}) {
        if (!this.trackers.hasOwnProperty(eventName))
            this.trackers[eventName] = new StatusTracker(eventName, options);
        else
            throw Exception(`Tracker for '${eventName}' has already been added!`);
    }

    removeTracker(eventName) {
        this.removeAllHooks(eventName);
        delete this.trackers[eventName];
    }

    removeAllTrackers() {
        for (let eventName of Object.keys(this.trackers))
            this.removeTracker(eventName);
    }

    addHook(eventName, fn) {
        if (this.trackers.hasOwnProperty(eventName))
            this.trackers[eventName].addHook(fn);
        else
            throw Exception(`Tracker for '${eventName}' does not exist!`);
    }

    removeHook(eventName, fn) {
        if (this.trackers.hasOwnProperty(eventName))
            this.trackers[eventName].removeHook(fn);
        else
            throw Exception(`Tracker for '${eventName}' does not exist!`);
    }

    removeAllHooks(eventName) {
        if (this.trackers.hasOwnProperty(eventName))
            this.trackers[eventName].removeAllHooks();
        else
            throw Exception(`Tracker for '${eventName}' does not exist!`);
    }

    setStatus(eventName, newVal, forceUpdate = false) {
        if (this.trackers.hasOwnProperty(eventName))
            this.trackers[eventName].set(newVal, forceUpdate);
        else
            throw Exception(`Tracker for '${eventName}' does not exist!`);
    }

    getStatus(eventName) {
        if (this.trackers.hasOwnProperty(eventName))
            return this.trackers[eventName].get();
        else
            throw Exception(`Tracker for '${eventName}' does not exist!`);
    }

    forceStatusUpdate(eventName) {
        if (this.trackers.hasOwnProperty(eventName))
            return this.trackers[eventName].forceUpdate();
        else
            throw Exception(`Tracker for '${eventName}' does not exist!`);
    }
}

module.exports = { StatusTracker, StatusTrackerMap };