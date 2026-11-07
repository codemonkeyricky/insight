file(GLOB LIB_HEADERS CONFIGURE_DEPENDS "include/shapes/*.h")

add_library(shapes STATIC src/shapes.cc ${LIB_HEADERS})
target_include_directories(shapes
  PUBLIC $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
  PRIVATE src)
