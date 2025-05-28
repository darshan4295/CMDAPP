topSuite("Ext.data.proxy.JsonP", ['Ext.data.ArrayStore'], function() {
    var proxy;

    beforeEach(function() {
        proxy = new Ext.data.proxy.JsonP({ noCache: false });
    });

    afterEach(function() {
        Ext.data.Model.schema.clear();
    });

    describe("instantiation", function() {
        it("should extend Ext.data.proxy.Server", function() {
            expect(proxy.superclass).toEqual(Ext.data.proxy.Server.prototype);
        });

        it("should have default writer to be json", function() {
            expect(proxy.getWriter() instanceof Ext.data.writer.Json).toBe(true);
        });

        it("should have callbackKey equal to callback", function() {
            expect(proxy.getCallbackKey()).toEqual('callback');
        });

        it("should have recordParam equal to records", function() {
            expect(proxy.getRecordParam()).toEqual('records');
        });

        it("should not have lastRequest defined", function() {
            expect(proxy.lastRequest).not.toBeDefined();
        });
    });

    describe("methods", function() {
        describe("buildUrl and encodeRecords", function() {
            var nicolas, request, thomas;

            beforeEach(function() {
                Ext.ClassManager.enableNamespaceParseCache = false;
                Ext.define('spec.Human', {
                    extend: 'Ext.data.Model',
                    fields: [
                        { name: 'name',  type: 'string' },
                        { name: 'age',   type: 'int' },
                        { name: 'planet', type: 'string' }
                    ]
                });
                nicolas = new spec.Human({
                    id: 1,
                    name: 'Nicolas',
                    age: 27,
                    planet: 'Earth'
                });
                thomas = new spec.Human({
                    id: 2,
                    name: 'thomas',
                    age: 28,
                    planet: 'Earth'
                });
                request = new Ext.data.Request({
                    url: 'somewhere',
                    records: [nicolas, thomas],
                    params: {
                        beyond: 'the_sea',
                        filters: [
                            new Ext.util.Filter({
                                property: 'filter',
                                value: 'value'
                            })
                        ]
                    },
                    operation: new Ext.data.operation.Read({
                    })
                });
            });

            afterEach(function() {
               Ext.undefine('spec.Human');
            });

            it("should return a url based on a given Ext.data.Request object", function() {
                var expected = 'somewhere?beyond=the_sea&filter=value&records=%7B%22id%22%3A1%2C%22name%22%3A%22Nicolas%22%2C%22age%22%3A27%2C%22planet%22%3A%22Earth%22%7D&records=%7B%22id%22%3A2%2C%22name%22%3A%22thomas%22%2C%22age%22%3A28%2C%22planet%22%3A%22Earth%22%7D';

                expect(proxy.buildUrl(request)).toEqual(expected);
            });

            it("should return a url based on a given Ext.data.Request object for arrayUrlEncodingFormat name", function() {
                var expected = 'somewhere?beyond=the_sea&filter=value&records=%7B%22id%22%3A1%2C%22name%22%3A%22Nicolas%22%2C%22age%22%3A27%2C%22planet%22%3A%22Earth%22%7D&records=%7B%22id%22%3A2%2C%22name%22%3A%22thomas%22%2C%22age%22%3A28%2C%22planet%22%3A%22Earth%22%7D';

                expect(proxy.buildUrl(request)).toEqual(expected);
            });

            it("should return a url based on a given Ext.data.Request object for arrayUrlEncodingFormat array", function() {
                var expected = 'somewhere?beyond=the_sea&filter=value&records=%5B%7B%22id%22%3A1%2C%22name%22%3A%22Nicolas%22%2C%22age%22%3A27%2C%22planet%22%3A%22Earth%22%7D%2C%7B%22id%22%3A2%2C%22name%22%3A%22thomas%22%2C%22age%22%3A28%2C%22planet%22%3A%22Earth%22%7D%5D';

                proxy.setArrayUrlEncodingFormat('array');
                expect(proxy.buildUrl(request)).toEqual(expected);
            });

            it("should return a url based on a given Ext.data.Request object for arrayUrlEncodingFormat indexed", function() {
                var expected = 'somewhere?beyond=the_sea&filter=value&records%5B0%5D=%7B%22id%22%3A1%2C%22name%22%3A%22Nicolas%22%2C%22age%22%3A27%2C%22planet%22%3A%22Earth%22%7D&records%5B1%5D=%7B%22id%22%3A2%2C%22name%22%3A%22thomas%22%2C%22age%22%3A28%2C%22planet%22%3A%22Earth%22%7D';

                proxy.setArrayUrlEncodingFormat('indexed');

                expect(proxy.buildUrl(request)).toEqual(expected);
            });
        });
    });
});
