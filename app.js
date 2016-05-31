const fs = require('fs');
const assert = require('assert');

const _ = require('lodash');
const Promise = require('bluebird');

const request = require('request');
const ProgressBar = require('progress');

const outputFile = './elist.json';

class EffectCrawler {
    constructor ({request, fs}) {
        this.request = request;
        this.fs = fs;

        this.pwCache = {};
        this.eCache = {};

        this.drugCache = {};
        this.drugNames = [];

        this.paths = {
            tripsit: {
                allDrugs: 'http://tripbot.tripsit.me/api/tripsit/getAllDrugs'
            },
            pw: {
                baseApi: 'http://psychonautwiki.org/w/api.php',
                askApiPrefix: 'https://psychonautwiki.org/w/api.php?action=ask&format=json&query='
            }
        };

        this.request = Promise.promisify(request, {
            multiArgs: true
        });
    }

    * processAllDrugs (drugCache) {
        const drugNames = [];

        _.each(drugCache, ({name, aliases = []}) =>
            drugNames.push(name, ...aliases)
        );

        this.drugNames = drugNames.slice(0, 150);
    }

    * getAllDrugs () {
        console.log('Getting all tripsit drugs..');

        const [res] = yield this.request(this.paths.tripsit.allDrugs, {
            json: true
        });

        const {body} = res;

        assert(_.isArray(body.data), 'Tripsit allDrugs list should be an array');
        assert(_.size(body.data), 'Tripsit allDrugs list should not be empty');

        const drugCache = _.first(body.data);

        yield* this.processAllDrugs(drugCache);
    }

    * getPWDrugs () {
        assert(_.size(this.drugNames), 'drugNames are not set or empty');

        const progress = new ProgressBar('Resolving to PsychonautWiki articles.. [:bar] [:current / :total] :percent :etas', {
            total: _.size(this.drugNames)
        });

        const pwNames = [];

        /* please keep this below 5, so that there's no unnecessary load on PW */
        const chunks = _.chunk(this.drugNames, 5);

        for (let i = 0; i < chunks.length; ++i) {
            const chunk = chunks[i];

            const pwMappingResource = _.map(chunk, name =>
                this.request(this.paths.pw.baseApi, {
                    'qs': {
                        'action': 'opensearch',
                        'search': name,
                        'limit': 1,
                        'namespace': 0,
                        'format': 'json'
                    },
                    'json': true
                }).spread((res, body) => {
                    /* increment progress bar by one */
                    progress.tick();

                    return body;
                })
            );

            const pwMapping = yield Promise.all(
                pwMappingResource
            );

            pwMapping.forEach(([term, match]) =>
                /* when there is a match, use our term */
                _.size(match) && pwNames.push(term)
            );
        }

        this.matchingDrugNames = pwNames;
    }

    * extractEffects () {
        const progress = new ProgressBar('Extracting effects.. [:bar] [:current / :total] :percent :etas', {
            total: _.size(this.matchingDrugNames)
        });

        const effectMap = {};

        const pwResolveRequestMap = _.map(this.matchingDrugNames, drugName =>
            this.request(`${this.paths.pw.askApiPrefix}[[-Effect::${drugName}]]`, {
                'json': true
            }).spread((res, {query}) => {
                progress.tick();

                return [drugName, query];
            })
        );

        const pwResolveMap = yield Promise.all(pwResolveRequestMap);

        pwResolveMap.forEach(([drugName, query]) => {
            if (!_.has(query, 'results') || _.isEmpty(query.results))
                return;

            const effects = {};

            _.each(query.results, ({fullurl}, effectName) => {
                effects[effectName] = fullurl
            });

            effectMap[drugName] = effects;
        });

        this.effectMap = effectMap;
    }

    * saveEffects (targetPath) {
        const plainText = JSON.stringify(this.effectMap);

        this.fs.writeFileSync(targetPath, plainText);
    }

    static * run (targetPath, {fs, request}) {
        const effectCrawler = new EffectCrawler({
            fs, request
        });

        yield* effectCrawler.getAllDrugs();
        yield* effectCrawler.getPWDrugs();

        yield* effectCrawler.extractEffects();

        yield* effectCrawler.saveEffects(targetPath);
    }
}

Promise.coroutine(function* () {
    console.log('Running..');

    yield* EffectCrawler.run(outputFile, {
        fs, request
    });

    console.log('Done, saved to %s!', outputFile);
})();

