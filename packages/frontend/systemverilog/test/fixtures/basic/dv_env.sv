class dv_child extends dv_pkg::dv_base;
  bi_t bi;
  virtual bus_if.mst vif;
  int total;

  function new(int v);
    super.new();
    total = v;
  endfunction

  function void run();
    int fd;
    super.log("start");
    this.step();
    wait_clks();
    vif.wait_clks();
    bi.send();
    total = c_add(total, 1);
    fd = $fopen("cfg.txt", "r");
    fd = $fopen("out.log", "w");
    fd = $fopen("multi.log");
    $fclose(fd);
  endfunction

  extern function void step();
endclass

function void dv_child::step();
  total++;
endfunction

class other_c;
  extern function void run();
endclass

function void other_c::run();
endfunction

class dv_grand extends dv_child;
  function void go();
    log("grand");
  endfunction
endclass
