/*
 * This file launches the application by asking Ext JS to create
 * and launch() the Application class.
 */
Ext.application({
    extend: 'CMDAPP.Application',

    name: 'CMDAPP',

    requires: [
        // This will automatically load all classes in the CMDAPP namespace
        // so that application classes do not need to require each other.
        'CMDAPP.*'
    ],

    // The name of the initial view to create.
    mainView: 'CMDAPP.view.main.Main'
});
