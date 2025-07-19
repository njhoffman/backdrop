the database will be sqlite3 with the following tables

``` javascript

// table that links search results to returned videos
const search = { 'id', 'date', 'keywords'  }

const pexel_videos = [{
    // video response fields, skip video_pictures
    "id", "width", "height", "url", "image", "duration", "user", "id", "url", "name",
    "video_files": [ {
        "id", "quality", "file_type", "width", "heiht", "link",
    }],

    // list of {searh_id, ranking #}  pairs sthat showed up in search
    searches = [],
    // downloaded is list array of sizes that were downloaded
    downloaded = [ video_file_id_ ]
}];

const pexel_images  = [{
    "id", "width", "height", "url", "photographer", "photographer_url", "photographer_id", "avg_color", "alt"
    "src": { "original", "large2x", "large", "medium", "small", "portrait", "landscape", "tiny"  }

    // list of {searh_id, ranking #}  pairs sthat showed up in search
    searches  = [],
    // downloaded is list array of sizes that were downloaded
    downloaded = [ ]
}]

const local_videos = [{
    "id",        // auto-increment primary key
    "filename",  // original filename
    "size",      // dimensions in format "widthxheight" (e.g. "1920x1080")
    "duration"   // duration in seconds
}];

const local_images = [{
    "id",        // auto-increment primary key  
    "filename",  // original filename
    "size"       // dimensions in format "widthxheight" (e.g. "1920x1080")
}];

const ratings = [{
    // numerical rating is numeric
    "date", "rating", "item_id",
    // resolution of monitor the video/image was rated on
    "resolution",
    // orientation of monitor: portrait (height > width) or landscape (width >= height)
    "orientation",
    // can be one of: pexel-image, pexel-video, local-image, local-video
    "source"
});


```

vim:ft=markdown