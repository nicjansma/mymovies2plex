//
// Imports
//
const async = require("async");
const parseString = require("xml2js").parseString;
const PlexAPI = require("plex-api");
const fs = require("fs");
const chalk = require("chalk");
const yargs = require("yargs");

//
// Command-line args
//
const argv = yargs
    .string("file")
    .describe("file", "My Movies Collection.xml file name")
    .string("host")
    .describe("host", "Plex host")
    .string("token")
    .describe("token", "Plex token")
    .string("section")
    .describe("section", "Section titles")
    .boolean("pretend")
    .describe("pretend", "Pretend (don't set status)")
    .default("pretend", false)
    .boolean("watched")
    .describe("watched", "Set Watched movies")
    .default("watched", false)
    .boolean("unwatched")
    .describe("unwatched", "Set Unwatched movies")
    .default("unwatched", false)
    .describe("movies", "Operate on Movies")
    .default("movies", false)
    .describe("tv", "Operate on TV shows")
    .default("tv", false)
    .describe("series-fix", "Series fix JSON file")
    .help()
    .strict()
    .version()
    .argv;

const fileName = argv.file;
const hostName = argv.host;
const token = argv.token;
const pretend = argv.pretend;
const sectionFilter = argv.section;
const setWatched = argv.watched;
const setUnwatched = argv.unwatched;
const setTv = argv.tv;
const setMovies = argv.movies;
const seriesFix = argv.seriesFix;

// check we have the basics set
if (!fileName || !hostName || !token) {
    console.error("Usage: node index.js --file 'Collection.xml' --host 'plexserver' --token 'foo'");
    process.exit(1);
}

if (!setWatched && !setUnwatched) {
    console.error("--watched or --unwatched must bet set");
    process.exit(1);
}

if (!setTv && !setMovies) {
    console.error("--tv or --movies must bet set");
    process.exit(1);
}

if (setTv && setMovies) {
    console.error("--tv and --movies cannot both be set");
    process.exit(1);
}

//
// Locals
//
var client = new PlexAPI({
    hostname: hostName,
    token: token
});

//
// Exec
//
async.waterfall([
    //
    // 1. Read in the My Movies Collections.xml
    //
    function readXml(cb) {
        console.log(`Reading ${chalk.green(fileName)}...`);
        fs.readFile(fileName, "utf-8", cb);
    },

    //
    // 2. Parse the XML into JS
    //
    function parseXml(fileContents, cb) {
        console.log("Parsing XML...");
        parseString(fileContents, cb);
    },

    //
    // 3. Movies: For each Disc, find titles that are in My Movies
    //
    function(collection, cb) {
        if (!collection ||
            !collection.Collection ||
            (!collection.Collection.DiscTitles && !collection.Collection.TVSeries)) {
            return cb("XML does not have DiscTitles or TVSeries!");
        }

        if (setMovies) {
            return goMovies(collection, cb);
        } else if (setTv) {
            return goTv(collection, cb);
        }

        return undefined;
    }
],
function(err, titlesNotSet) {
    //
    // End of tasks
    //
    console.log();

    if (err) {
        console.error(chalk.red(JSON.stringify(err)));
    }

    if (titlesNotSet.length) {
        if (pretend) {
            console.log(chalk.yellow("Pretend mode!  Did not change anything.\n"));
        }

        console.log(chalk.yellow("Could not set:"));

        titlesNotSet.forEach(function(title) {
            console.log(chalk.yellow(`\t ✖ ${title.series ? title.series : ""}` +
                `${title.season ? " Season " + title.season : ""} ` +
                `${title.title} (${title.imdb ? title.imdb : "tt?"}) to ` +
                `${title.watched ? "watched" : "unwatched"}`));
        });
    }

    console.log("Done!");
});

function goMovies(collection, callback) {
    async.waterfall([
        //
        // 1. For each Disc, find titles that are in My Movies
        //
        function(cb) {
            console.log(`Checking ${collection.Collection.DiscTitles[0].DiscTitle.length} titles...`);

            // titles
            let titles = [];

            async.eachSeries(
                collection.Collection.DiscTitles[0].DiscTitle,
                function(title, cbTitle) {
                    // Watched is an attribute on PersonalData
                    const watched = title.PersonalData &&
                        title.PersonalData[0] &&
                        title.PersonalData[0].$ &&
                        title.PersonalData[0].$.Watched === "True";

                    console.log(`\t${title.LocalTitle} (${title.IMDB}):`
                        + ` ${watched ? chalk.green("Watched") : chalk.yellow("Unwatched")}`);

                    if (setWatched && watched) {
                        titles.push({
                            title: title.LocalTitle[0].trim(),
                            imdb: title.IMDB[0].trim(),
                            watched: true
                        });
                    }

                    if (setUnwatched && !watched) {
                        titles.push({
                            title: title.LocalTitle[0].trim(),
                            imdb: title.IMDB[0].trim(),
                            watched: false
                        });
                    }

                    cbTitle();
                },
                function(err) {
                    cb(err, titles);
                });

            return undefined;
        },

        //
        // 2. Connect to Plex server
        //
        function(titles, cb) {
            console.log();
            console.log(`Connecting to Plex server at ${hostName}...`);

            client.query("/").then(function(result) {
                console.log(`\tPlex server version ${chalk.green(result.MediaContainer.version)}`);

                cb(null, titles);
            }, function(err) {
                cb(err);
            });
        },

        //
        // 3. Find Sections that contain Movies
        //
        function(titles, cb) {
            console.log("Checking Plex Library...");

            client
                .query("/library/sections")
                .then(results => {
                    console.log(`\tFound ${chalk.green(results.MediaContainer.Directory.length)} sections.`);

                    // filter to the specified sections
                    let filteredSections = results.MediaContainer.Directory;

                    if (sectionFilter && sectionFilter.length) {
                        filteredSections = results.MediaContainer.Directory.filter(function(section) {
                            return section && sectionFilter.indexOf(section.title) !== -1;
                        });
                    }

                    console.log(`\tFiltered to ${chalk.green(filteredSections.length)} sections: ` +
                        filteredSections.map(s => s.title).join(", "));

                    return cb(null, titles, filteredSections);
                })
                .catch(cb);
        },

        //
        // 4. Mark movies in each Section as Watched/Unwatched
        //
        function(titles, filteredSections, cb) {
            let watchedTitles = titles.filter(function(title) {
                return title.watched;
            });

            let unWatchedTitles = titles.filter(function(title) {
                return !title.watched;
            });

            if (setWatched) {
                console.log(`Marking ${watchedTitles.length} watched...`);
            }

            if (setUnwatched) {
                console.log(`Marking ${unWatchedTitles.length} unwatched...`);
            }

            // titles we could not set Watched status on
            let titlesNotSet = [];

            // loop over all Watched titles
            async.eachSeries(titles, function(title, cbEachTitle) {
                console.log(`\t${title.title}:`);

                // Need an IMDB match
                if (!title.imdb) {
                    console.log(chalk.yellow("\t\t✖ no IMDB"));

                    titlesNotSet.push(title);

                    return cbEachTitle();
                }

                // loop over all filtered Sections
                return async.eachSeries(filteredSections, function(section, cbEachSection) {

                    // find all titles that match via IMDB ID
                    client.query(`/library/sections/${section.key}/all?guid=` + encodeURIComponent(title.imdb))
                        .then(function(titleSearch) {

                            // could not find any matches
                            if (titleSearch.MediaContainer.size === 0) {
                                console.log(chalk.yellow("\t\t✖ no matches"));

                                titlesNotSet.push(title);
                                return cbEachSection();
                            }

                            let plexTitle = titleSearch.MediaContainer.Metadata[0];

                            console.log(`\t\t${chalk.green("✔ #" + plexTitle.ratingKey)}`);

                            if (pretend) {
                                return cbEachSection();
                            }

                            // Mark as Watched
                            if (setWatched && title.watched) {
                                client.query("/:/scrobble?identifier=com.plexapp.plugins.library&key=" +
                                    plexTitle.ratingKey)
                                    .then(function() {
                                        cbEachSection();
                                    }, cbEachSection);
                            } else if (setUnwatched && !title.watched) {
                                client.query("/:/unscrobble?identifier=com.plexapp.plugins.library&key=" +
                                    plexTitle.ratingKey)
                                    .then(function() {
                                        cbEachSection();
                                    }, cbEachSection);
                            }

                            return undefined;
                        });
                },
                cbEachTitle);
            },
            function(err) {
                cb(err, titlesNotSet);
            });
        }
    ],
    callback);
}

function goTv(collection, callback) {
    async.waterfall([
        //
        // 1. For each TV series, find episodes
        //
        function(cb) {
            console.log(`Checking ${collection.Collection.TVSeries[0].Series.length} series...`);

            let episodes = [];

            async.eachSeries(
                collection.Collection.TVSeries[0].Series,
                function(series, cbSeries) {
                    let seriesTitle = series.LanguageSpecific[0].Title[0];
                    console.log(`\t${seriesTitle} : ${series.Episodes[0].Episode.length} episodes`);

                    async.eachSeries(
                        series.Episodes[0].Episode,
                        function(episode, cbEpisode) {
                            const seasonNum = episode.Global[0].SeasonNumber[0];
                            const episodeNum = episode.Global[0].EpisodeNumber[0];
                            const episodeTitle = episode.LanguageSpecific[0].Title[0];
                            const owned = episode.Global &&
                                episode.Global[0] &&
                                episode.Global[0].Owned &&
                                episode.Global[0].Owned[0] === "True";

                            const watched = episode.Personal &&
                                episode.Personal[0] &&
                                episode.Personal[0].Watched &&
                                episode.Personal[0].Watched[0] === "True";

                            console.log(`\t\tSeason ${seasonNum} Episode ${episodeNum}: ${episodeTitle}: ` +
                                `${watched ? "watched" : "unwatched"}` +
                                `${owned ? "" : " (unowned, skipping)"}`);

                            if (!owned) {
                                // skip
                                return cbEpisode();
                            }

                            const episodeData = {
                                series: seriesTitle,
                                season: seasonNum,
                                episode: episodeNum,
                                title: episodeTitle,
                                watched: watched
                            };

                            if (setWatched && watched) {
                                episodes.push(episodeData);
                            }

                            if (setUnwatched && !watched) {
                                episodes.push(episodeData);
                            }

                            return cbEpisode();
                        },
                        cbSeries);
                },
                function(err) {
                    cb(err, episodes);
                });
            return undefined;
        },

        //
        // 2. Connect to Plex server
        //
        function(episodes, cb) {
            console.log();
            console.log(`Connecting to Plex server at ${hostName}...`);

            client.query("/").then(function(result) {
                console.log(`\tPlex server version ${chalk.green(result.MediaContainer.version)}`);

                cb(null, episodes);
            }, function(err) {
                cb(err);
            });
        },

        //
        // 3. Find Sections that contain TV Shows
        //
        function(episodes, cb) {
            console.log();
            console.log("Checking Plex Library...");

            client
                .query("/library/sections")
                .then(results => {
                    console.log(`\tFound ${chalk.green(results.MediaContainer.Directory.length)} sections.`);

                    // filter to the specified sections
                    let filteredSections = results.MediaContainer.Directory;

                    if (sectionFilter && sectionFilter.length) {
                        filteredSections = results.MediaContainer.Directory.filter(function(section) {
                            return section && sectionFilter.indexOf(section.title) !== -1;
                        });
                    }

                    console.log(`\tFiltered to ${chalk.green(filteredSections.length)} sections: ` +
                        filteredSections.map(s => s.title).join(", "));

                    return cb(null, episodes, filteredSections);
                })
                .catch(cb);
        },

        //
        // 4. Get IDs of all Series/Episodes in Plex
        //
        function(episodes, filteredSections, cb) {
            console.log();
            console.log("Finding Plex TV Series...");

            let plexSeries = {};

            // loop over all filtered Sections
            async.eachSeries(filteredSections, function(section, cbEachSection) {
                // find all titles that match via IMDB ID
                client.query(`/library/sections/${section.key}/all`)
                    .then(function(titleSearch) {
                        console.log(`Found ${chalk.green(titleSearch.MediaContainer.size)} TV shows.`);

                        let tvSeries = titleSearch.MediaContainer.Metadata;

                        async.eachSeries(tvSeries, function(series, cbEachSeries) {
                            plexSeries[series.title] = {
                                key: series.key,
                                seasons: []
                            };

                            console.log(`\t${series.title}: ${series.childCount} season` +
                                `, ${series.leafCount} episodes:`);

                            client.query(`${series.key}`)
                                .then(function(seasonSearch) {
                                    async.eachSeries(
                                        seasonSearch.MediaContainer.Metadata,
                                        function(season, cbEachSeason) {
                                            console.log(`\t\t${season.title}: ${season.leafCount} episodes:`);

                                            plexSeries[series.title].seasons[season.index] = [];

                                            client.query(`${season.key}`)
                                                .then(function(epSearch) {
                                                    async.eachSeries(
                                                        epSearch.MediaContainer.Metadata,
                                                        function(episode, cbEachEpisode) {

                                                            let watched = episode.viewCount > 0;

                                                            console.log(`\t\t\t${episode.title}: ` +
                                                                `${watched ? chalk.green("Watched") : chalk.yellow("Unwatched")}`);

                                                            plexSeries[series.title]
                                                                .seasons[season.index][episode.index] =
                                                                    episode.ratingKey;

                                                            cbEachEpisode();
                                                        }, cbEachSeason);
                                                });
                                        }, cbEachSeries);
                                });
                        }, cbEachSection);
                    });
            },
            function(err) {
                cb(err, episodes, filteredSections, plexSeries);
            });
        },

        //
        // 5. Load series.json for match
        //
        function(episodes, filteredSections, plexSeries, cb) {
            if (!seriesFix) {
                return cb(null, episodes, filteredSections, plexSeries);
            }

            if (!fs.existsSync(seriesFix)) {
                return cb(`${seriesFix} not found!`);
            }

            console.log();
            console.log(`Fixing TV series mappings view ${seriesFix}`);

            var seriesFixJson = JSON.parse(fs.readFileSync(seriesFix, "utf-8"));

            // match up via file
            for (var seriesName in seriesFixJson) {
                for (var plexSeriesName in plexSeries) {
                    if (plexSeries[plexSeriesName].key === seriesFixJson[seriesName]) {
                        plexSeries[seriesName] = plexSeries[plexSeriesName];
                    }
                }

                console.log(`\t${seriesName} -> ${seriesFixJson[seriesName]}`);
            }

            return cb(null, episodes, filteredSections, plexSeries);
        },

        //
        // 6. Look for TV series that don't match
        //
        function(episodes, filteredSections, plexSeries, cb) {
            console.log();
            console.log("Checking that Plex TV Series names match...");

            let seriesNotMatched = [];

            const series = [...new Set(episodes.map(episode => episode.series))];

            series.forEach(function(seriesName) {
                if (!plexSeries[seriesName]) {
                    seriesNotMatched.push(seriesName);
                }
            });

            if (seriesNotMatched.length) {
                console.error(`${seriesNotMatched.length} TV Series not matched.`);
                console.error("Use series.json to fix matchings. Example:");
                console.error();
                console.error("{");
                seriesNotMatched.forEach(function(seriesName) {
                    console.error(`    "${seriesName}": "/library/metadata/n/children",`);
                });
                console.error("}");
                console.error();

                console.error("Use these Plex TV series keys: ");

                for (var seriesName in plexSeries) {
                    console.error(`\t${seriesName}: ${plexSeries[seriesName].key}`);
                }

                return cb("Could not match all series!");
            }

            console.error("\tAll good!");

            return cb(null, episodes, filteredSections, plexSeries);
        },

        //
        // 7. Mark TV Shows in each Section as Watched/Unwatched
        //
        function(episodes, filteredSections, plexSeries, cb) {
            console.log();

            let watchedEpisodes = episodes.filter(function(title) {
                return title.watched;
            });

            let unWatchedEpisodes = episodes.filter(function(title) {
                return !title.watched;
            });

            if (setWatched) {
                console.log(`Marking ${watchedEpisodes.length} watched.`);
            }

            if (setUnwatched) {
                console.log(`Marking ${unWatchedEpisodes.length} unwatched.`);
            }

            console.log("Marking...");

            // eposides we could not set Watched status on
            let episodesNotSet = [];

            // loop over all titles
            async.eachSeries(episodes, function(episode, cbEachTitle) {
                console.log(`\t${episode.series}: Season ${episode.season} ` +
                    `Episode ${episode.episode}: ${episode.title}: ` +
                    `${episode.watched ? "watched" : "unwatched"}`);

                if (!plexSeries[episode.series] ||
                    !plexSeries[episode.series].seasons[episode.season] ||
                    !plexSeries[episode.series].seasons[episode.season][episode.episode]) {
                    episodesNotSet.push(episode);
                    return cbEachTitle();
                }

                if (pretend) {
                    return cbEachTitle();
                }

                let plexKey = plexSeries[episode.series].seasons[episode.season][episode.episode];

                // Mark as Watched
                if (setWatched && episode.watched) {
                    client.query("/:/scrobble?identifier=com.plexapp.plugins.library&key=" +
                        plexKey)
                        .then(function() {
                            cbEachTitle();
                        }, cbEachTitle);
                } else if (setUnwatched && !episode.watched) {
                    client.query("/:/unscrobble?identifier=com.plexapp.plugins.library&key=" +
                        plexKey)
                        .then(function() {
                            cbEachTitle();
                        }, cbEachTitle);
                }

                return undefined;
            },
            function(err) {
                cb(err, episodesNotSet);
            });
        }
    ],
    callback);
}
