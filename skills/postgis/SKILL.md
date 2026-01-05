---
name: postgis-skill
description: PostGIS-focused SQL tips, tricks and gotchas. Use when in need of dealing with geospatial data in Postgres.
---

## Style

- PostGIS functions follow their spelling from the manual (`st_segmentize` -> `ST_Segmentize`).
- SQL is lowercase unless instructed otherwise.
- Call geometry column `geom`; geography column `geog`.

## Debugging

- Don't stub stuff out with insane fallbacks (like lat/lon=0) - instead make the rest of the code work around data absence and inform user.
- Check `select postgis_full_version();` to see if all upgrades happened successfully.

## Raster

- Do not work with GDAL on the filesystem. Import things into database and deal with data there.

## PostGIS gotchas

- Do not use geometry typmod unless requested (things like `geometry(multilinestring, 4326)`) - use plain `geometry` or `geography` instead. This removes clutter of `ST_Multi` and errors via `ST_SetSRID`.
- `ST_UnaryUnion(ST_Collect(geom))` is just `ST_Union(geom)`
- `ST_Buffer(geom, 0)` should be `ST_MakeValid(geom)`
- `select min(ST_Distance(..))` should be `select ST_Distance() ... order by a <-> b limit 1` to enable knn gist
- `order by ST_Distance(c.geog, t.geog)` should be `order by c.geog <-> t.geog`
- `ST_UnaryUnion` is a sign you're doing something wrong
- `ST_MakeValid` is a sign you're doing something wrong on the previous step
- be extra attintive when calling `ST_SetSRID`: check the actual projection of input data, check if it can be set correctly during input (`ST_GeomFromGeoJSON`, `EWKT`-style `SRID=4326;POINT(...`, `EWKB` allow that). Check if `ST_Transform` is needed instead.
- when looking for relation between point and polygon, prefer `ST_Intersects` to other topology predicates
- when generating complex geometry by walking raster or grid, may make sense to `ST_Simplify(geom, 0)`
- to generate neighbourhoods of predictable size, use `ST_ClusterKMeans` with k=2 and `max_radius` set to your distance.
- use `ST_AsEWKB` for binary representation instead of `ST_AsWKB` to keep SRID.
- Choosing projection:
  SRID=4326 (2D longlat) when input or output is longitude and latitude and coordinate value is to be shown to user.
  SRID=3857 (2D Spherical Mercator) when output will be shown on web map, ST_AsMVT, or 2D KNN requests of short distance are to be executed.
  SRID=4978 (3D XYZ) when performing internal computations, line-of-sight, clustering and averaging across antimeridian. Beware: only use 3D-aware operations, ST_Force3DZ on 2D CRS data before calling ST_Transform to it.
- Instead of using `ST_Hexagon` / `ST_HexagonGrid` use `h3` extension.
- When you know the data is going to be dumped in binary form, gzipped and moved around, consider using `ST_QuantizeCoordinates` if precision is known.
